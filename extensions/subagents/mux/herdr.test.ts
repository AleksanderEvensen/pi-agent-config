import { Effect } from "effect";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHerdrLayer } from "./herdr.ts";
import { Mux, MuxError, type SpawnRequest } from "./service.ts";

const FAKE_HERDR = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.FAKE_HERDR_LOG;
const statePath = process.env.FAKE_HERDR_STATE;
const mode = process.env.FAKE_HERDR_MODE;
if (!logPath || !statePath || !mode) process.exit(2);
appendFileSync(logPath, JSON.stringify(args) + "\n");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

if (args[0] === "pane" && args[1] === "split") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
  process.exit(0);
}

if (args[0] === "pane" && args[1] === "run") {
  const match = /bash '([^']+)'/.exec(args[3] ?? "");
  state.scriptPath = match?.[1];
  state.script = state.scriptPath ? readFileSync(state.scriptPath, "utf8") : "";
  writeFileSync(statePath, JSON.stringify(state));
  if (mode === "run-failure") {
    console.error(JSON.stringify({ error: { code: "fake_run_failure", message: "run failed" } }));
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] === "pane" && args[1] === "process-info") {
  state.polls = (state.polls ?? 0) + 1;
  writeFileSync(statePath, JSON.stringify(state));
  const running = mode === "abort" || state.polls === 1;
  console.log(JSON.stringify({
    result: {
      process_info: {
        foreground_process_group_id: running ? 200 : 100,
        foreground_processes: running
          ? [{ pid: 200, argv: ["bash", state.scriptPath], cmdline: "bash " + state.scriptPath }]
          : [{ pid: 100, argv: ["bash"], cmdline: "bash" }],
      },
    },
  }));
  process.exit(0);
}

process.exit(0);
`;

const request: SpawnRequest = {
  name: "test pane",
  cwd: process.cwd(),
  command: "/bin/true",
  args: [],
  closeOnExit: false,
};

type FakeHerdrState = {
  readonly scriptPath?: string;
  readonly script?: string;
};

async function withFakeHerdr<T>(mode: string, run: (logPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-mux-test-"));
  const executable = join(directory, "herdr");
  const logPath = join(directory, "calls.jsonl");
  const statePath = join(directory, "state.json");
  const previousPath = process.env.PATH;
  const previousMode = process.env.FAKE_HERDR_MODE;
  const previousLog = process.env.FAKE_HERDR_LOG;
  const previousState = process.env.FAKE_HERDR_STATE;

  await writeFile(executable, FAKE_HERDR);
  await chmod(executable, 0o700);
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  process.env.FAKE_HERDR_MODE = mode;
  process.env.FAKE_HERDR_LOG = logPath;
  process.env.FAKE_HERDR_STATE = statePath;

  try {
    return await run(logPath);
  } finally {
    const state = await readFile(statePath, "utf8")
      .then((value): FakeHerdrState => JSON.parse(value))
      .catch((): FakeHerdrState => ({}));

    const temporaryPaths = state.script?.match(/'([^']*pi-subagent-[^']*)'/g) ?? [];

    for (const quotedPath of temporaryPaths) {
      const path = quotedPath.slice(1, -1);
      await rm(path, { force: true });
    }

    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;

    if (previousMode === undefined) delete process.env.FAKE_HERDR_MODE;
    else process.env.FAKE_HERDR_MODE = previousMode;

    if (previousLog === undefined) delete process.env.FAKE_HERDR_LOG;
    else process.env.FAKE_HERDR_LOG = previousLog;

    if (previousState === undefined) delete process.env.FAKE_HERDR_STATE;
    else process.env.FAKE_HERDR_STATE = previousState;

    await rm(directory, { recursive: true, force: true });
  }
}

function spawnAndWait(signal: AbortSignal) {
  return Effect.gen(function* () {
    const mux = yield* Mux;
    const { paneId } = yield* mux.spawn(request);

    return yield* mux.waitForExit(paneId, signal);
  }).pipe(Effect.provide(createHerdrLayer()));
}

test("Herdr mux lifecycle", async (t) => {
  await t.test("waits for the tracked foreground process without reading pane output", async () => {
    await withFakeHerdr("exit", async (logPath) => {
      const result = await Effect.runPromise(spawnAndWait(new AbortController().signal));

      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line): string[] => JSON.parse(line));

      assert.deepEqual(result, { paneId: "w1:p2", reason: "process-exited" });
      assert.ok(calls.some((args) => args[1] === "process-info"));
      assert.ok(calls.every((args) => args[1] !== "read" && args[1] !== "wait-output"));
    });
  });

  await t.test("aborts an in-progress wait", async () => {
    await withFakeHerdr("abort", async () => {
      const controller = new AbortController();
      const waiting = Effect.runPromise(spawnAndWait(controller.signal));
      setTimeout(() => controller.abort(), 20);

      await assert.rejects(
        waiting,
        (error) => error instanceof MuxError && error.code === "aborted",
      );
    });
  });

  await t.test("sends steering text through the Herdr agent prompt surface", async () => {
    await withFakeHerdr("exit", async (logPath) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const mux = yield* Mux;
          yield* mux.sendInput("w1:p2", "Focus on the failing test.");
        }).pipe(Effect.provide(createHerdrLayer())),
      );

      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line): string[] => JSON.parse(line));

      assert.deepEqual(calls, [["agent", "prompt", "w1:p2", "Focus on the failing test."]]);
    });
  });

  await t.test("rolls back a pane and temporary files while keeping the launch error", async () => {
    await withFakeHerdr("run-failure", async (logPath) => {
      const spawning = Effect.runPromise(
        Effect.gen(function* () {
          const mux = yield* Mux;

          return yield* mux.spawn(request);
        }).pipe(Effect.provide(createHerdrLayer())),
      );

      await assert.rejects(
        spawning,
        (error) =>
          error instanceof MuxError &&
          error.code === "fake_run_failure" &&
          error.message.includes("run failed"),
      );

      const state: FakeHerdrState = JSON.parse(
        await readFile(process.env.FAKE_HERDR_STATE!, "utf8"),
      );

      const paths = state.script?.match(/'([^']*pi-subagent-[^']*)'/g) ?? [];

      assert.ok(paths.length >= 2);

      for (const quotedPath of paths) {
        await assert.rejects(readFile(quotedPath.slice(1, -1)));
      }

      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line): string[] => JSON.parse(line));

      assert.ok(calls.some((args) => args[0] === "pane" && args[1] === "close"));
    });
  });
});
