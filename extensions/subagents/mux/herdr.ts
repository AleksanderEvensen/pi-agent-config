import { Effect, FileSystem, Layer, Schema } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeJson, NodeFileSystemLayer } from "../../../lib/effect.ts";
import { Mux, MuxError, type ExitResult, type SpawnRequest } from "./service.ts";

const execFileAsync = promisify(execFile);

const SplitResponse = Schema.Struct({
  result: Schema.Struct({
    pane: Schema.Struct({ pane_id: Schema.String }),
  }),
});

const ProcessInfoResponse = Schema.Struct({
  result: Schema.Struct({
    process_info: Schema.Struct({
      foreground_process_group_id: Schema.optional(Schema.NullOr(Schema.Number)),
      foreground_processes: Schema.Array(
        Schema.Struct({
          pid: Schema.Number,
          argv: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
          cmdline: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  }),
});

type ProcessInfo = Schema.Schema.Type<typeof ProcessInfoResponse>["result"]["process_info"];

type TrackedProcess = {
  readonly pid: number;
  readonly processGroupId?: number;
};

const PROCESS_START_ATTEMPTS = 200;

const PROCESS_POLL_INTERVAL_MS = 25;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function herdrCommandLine(
  command: string,
  args: readonly string[],
  closePaneId?: string,
): string {
  const invocation = [command, ...args].map(shellQuote).join(" ");

  if (!closePaneId) return invocation;

  return `${invocation}; status=$?; if [ "$status" -eq 0 ]; then herdr pane close ${shellQuote(closePaneId)}; else printf '\\nSubagent exited with status %s; pane kept open for inspection.\\n' "$status"; fi`;
}

export function herdrScriptCommand(scriptPath: string): string {
  return `bash ${shellQuote(scriptPath)}`;
}

function abortedError(): MuxError {
  return new MuxError({ mux: "herdr", code: "aborted", message: "Pane exit wait was aborted" });
}

function commandError(cause: unknown): MuxError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = /"code":"([^"]+)"/.exec(message)?.[1];

  return code
    ? new MuxError({ mux: "herdr", message, code })
    : new MuxError({ mux: "herdr", message });
}

const runHerdr = Effect.fn("HerdrMux.runHerdr")(function* (
  args: readonly string[],
  signal?: AbortSignal,
) {
  if (signal?.aborted) return yield* Effect.fail(abortedError());

  return yield* Effect.tryPromise({
    try: () => execFileAsync("herdr", [...args], { signal }),
    catch: (cause) => (signal?.aborted ? abortedError() : commandError(cause)),
  });
});

const readProcessInfo = Effect.fn("HerdrMux.readProcessInfo")(function* (
  paneId: string,
  signal?: AbortSignal,
) {
  const response = yield* runHerdr(["pane", "process-info", "--pane", paneId], signal);

  return yield* decodeJson(ProcessInfoResponse, response.stdout).pipe(
    Effect.map((value) => value.result.process_info),
    Effect.mapError(
      (cause) =>
        new MuxError({
          mux: "herdr",
          message: `Invalid response from herdr pane process-info: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  );
});

function processForScript(info: ProcessInfo, scriptPath: string): TrackedProcess | undefined {
  const process = info.foreground_processes.find(
    ({ argv, cmdline }) => argv?.includes(scriptPath) || cmdline?.includes(scriptPath),
  );

  if (!process) return undefined;

  const processGroupId = info.foreground_process_group_id;

  return processGroupId === undefined || processGroupId === null
    ? { pid: process.pid }
    : { pid: process.pid, processGroupId };
}

function isProcessRunning(info: ProcessInfo, tracked: TrackedProcess): boolean {
  if (tracked.processGroupId !== undefined) {
    return info.foreground_process_group_id === tracked.processGroupId;
  }

  return info.foreground_processes.some(({ pid }) => pid === tracked.pid);
}

function pollDelay(signal?: AbortSignal): Effect.Effect<void, MuxError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);

          return;
        }

        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal?.reason);
        };

        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, PROCESS_POLL_INTERVAL_MS);

        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    catch: () => abortedError(),
  });
}

const waitForProcessStart = Effect.fn("HerdrMux.waitForProcessStart")(function* (
  paneId: string,
  scriptPath: string,
) {
  for (let attempt = 0; attempt < PROCESS_START_ATTEMPTS; attempt += 1) {
    const tracked = processForScript(yield* readProcessInfo(paneId), scriptPath);

    if (tracked) return tracked;
    yield* pollDelay();
  }

  return yield* Effect.fail(
    new MuxError({ mux: "herdr", message: `Timed out waiting for process in pane ${paneId}` }),
  );
});

const makeMux = Effect.fn("HerdrMux.make")(function* (
  trackedProcesses: Map<string, TrackedProcess>,
) {
  const fs = yield* FileSystem.FileSystem;

  const spawn = Effect.fn("HerdrMux.spawn")(function* (request: SpawnRequest) {
    const splitArgs = ["pane", "split", "--current", "--direction", "right", "--cwd", request.cwd];

    for (const [name, value] of Object.entries(request.environment ?? {})) {
      splitArgs.push("--env", `${name}=${value}`);
    }

    splitArgs.push("--no-focus");
    const split = yield* runHerdr(splitArgs);

    const paneId = yield* decodeJson(SplitResponse, split.stdout).pipe(
      Effect.map((response) => response.result.pane.pane_id),
      Effect.mapError(
        (cause) =>
          new MuxError({
            mux: "herdr",
            message: `Invalid response from herdr pane split: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
    );

    let scriptPath: string | undefined;
    let gatePath: string | undefined;

    const rollback = Effect.gen(function* () {
      trackedProcesses.delete(paneId);

      if (scriptPath) yield* fs.remove(scriptPath).pipe(Effect.ignore);

      if (gatePath) yield* fs.remove(gatePath).pipe(Effect.ignore);

      yield* runHerdr(["pane", "close", paneId]).pipe(Effect.ignore);
    });

    return yield* Effect.gen(function* () {
      yield* runHerdr(["pane", "rename", paneId, request.name]);

      scriptPath = yield* fs
        .makeTempFile({ prefix: "pi-subagent-", suffix: ".sh" })
        .pipe(Effect.mapError((cause) => new MuxError({ mux: "herdr", message: String(cause) })));
      gatePath = yield* fs
        .makeTempFile({ prefix: "pi-subagent-", suffix: ".gate" })
        .pipe(Effect.mapError((cause) => new MuxError({ mux: "herdr", message: String(cause) })));

      const script = [
        "#!/usr/bin/env bash",
        `while [ -e ${shellQuote(gatePath)} ]; do sleep 0.05; done`,
        `rm -f -- ${shellQuote(scriptPath)} ${shellQuote(gatePath)}`,
        herdrCommandLine(request.command, request.args, request.closeOnExit ? paneId : undefined),
        "",
      ].join("\n");

      yield* fs
        .writeFileString(scriptPath, script, { mode: 0o600 })
        .pipe(Effect.mapError((cause) => new MuxError({ mux: "herdr", message: String(cause) })));

      yield* runHerdr(["pane", "run", paneId, herdrScriptCommand(scriptPath)]);
      trackedProcesses.set(paneId, yield* waitForProcessStart(paneId, scriptPath));
      yield* fs
        .remove(gatePath)
        .pipe(Effect.mapError((cause) => new MuxError({ mux: "herdr", message: String(cause) })));

      return { paneId };
    }).pipe(Effect.tapError(() => rollback));
  });

  const waitForExit = Effect.fn("HerdrMux.waitForExit")(function* (
    paneId: string,
    signal: AbortSignal,
  ) {
    const tracked = trackedProcesses.get(paneId);

    if (!tracked) {
      return yield* Effect.fail(
        new MuxError({ mux: "herdr", message: `No tracked process for pane ${paneId}` }),
      );
    }

    return yield* Effect.gen(function* () {
      while (true) {
        const info = yield* readProcessInfo(paneId, signal).pipe(
          Effect.catch((error) =>
            error.code === "pane_not_found"
              ? Effect.succeed<ExitResult>({ paneId, reason: "pane-closed" })
              : Effect.fail(error),
          ),
        );

        if ("reason" in info) return info;

        if (!isProcessRunning(info, tracked)) {
          return { paneId, reason: "process-exited" } satisfies ExitResult;
        }

        yield* pollDelay(signal);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => trackedProcesses.delete(paneId))));
  });

  const sendInput = Effect.fn("HerdrMux.sendInput")(function* (paneId: string, text: string) {
    yield* runHerdr(["agent", "prompt", paneId, text]);
  });

  return { spawn, waitForExit, sendInput };
});

export function createHerdrLayer(): Layer.Layer<Mux> {
  // The extension provides this layer in separate Effect runs. Keep process
  // state in the layer closure so waitForExit sees the preceding spawn.
  const trackedProcesses = new Map<string, TrackedProcess>();

  return Layer.effect(
    Mux,
    Effect.gen(function* () {
      const { spawn, waitForExit, sendInput } = yield* makeMux(trackedProcesses);

      return Mux.of({ id: "herdr", spawn, waitForExit, sendInput });
    }),
  ).pipe(Layer.provide(NodeFileSystemLayer));
}

export const HerdrLayer = createHerdrLayer();
