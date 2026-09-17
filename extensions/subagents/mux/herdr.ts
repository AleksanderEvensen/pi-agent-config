import { Effect, FileSystem, Layer, Schema } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeJson, NodeFileSystemLayer } from "../../../lib/effect.ts";
import { Mux, MuxError, type SpawnRequest } from "./service.ts";

const execFileAsync = promisify(execFile);

const SplitResponse = Schema.Struct({
  result: Schema.Struct({
    pane: Schema.Struct({ pane_id: Schema.String }),
  }),
});

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

const runHerdr = Effect.fn("HerdrMux.runHerdr")(function* (args: readonly string[]) {
  return yield* Effect.tryPromise({
    try: () => execFileAsync("herdr", [...args]),
    catch: (cause) =>
      new MuxError({
        mux: "herdr",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

const makeSpawn = Effect.fn("HerdrMux.makeSpawn")(function* () {
  const fs = yield* FileSystem.FileSystem;

  return Effect.fn("HerdrMux.spawn")(function* (request: SpawnRequest) {
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

    yield* runHerdr(["pane", "rename", paneId, request.name]);

    const scriptPath = yield* fs
      .makeTempFile({ prefix: "pi-subagent-", suffix: ".sh" })
      .pipe(Effect.mapError((cause) => new MuxError({ mux: "herdr", message: String(cause) })));
    const script = [
      "#!/usr/bin/env bash",
      `rm -f -- ${shellQuote(scriptPath)}`,
      herdrCommandLine(request.command, request.args, request.closeOnExit ? paneId : undefined),
      "",
    ].join("\n");
    yield* fs
      .writeFileString(scriptPath, script, { mode: 0o600 })
      .pipe(Effect.mapError((cause) => new MuxError({ mux: "herdr", message: String(cause) })));

    yield* runHerdr(["pane", "run", paneId, herdrScriptCommand(scriptPath)]).pipe(
      Effect.tapError(() => fs.remove(scriptPath).pipe(Effect.ignore)),
    );

    return { paneId };
  });
});

export function makeHerdrLayer(): Layer.Layer<Mux> {
  return Layer.effect(
    Mux,
    Effect.gen(function* () {
      const spawn = yield* makeSpawn();
      return Mux.of({ id: "herdr", spawn });
    }),
  ).pipe(Layer.provide(NodeFileSystemLayer));
}
