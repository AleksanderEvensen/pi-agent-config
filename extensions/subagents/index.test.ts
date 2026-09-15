import assert from "node:assert/strict";
import test from "node:test";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import subagentChild from "./agent-extension/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDiscovery, discoverAgents } from "./agents.ts";
import { agentArguments, CHILD_EXTENSION_PATH, watchSubagentResult } from "./index.ts";
import { herdrCommandLine, herdrScriptCommand } from "./mux/herdr.ts";

const agent = {
  name: "scout",
  description: "Scout",
  tools: ["read", "grep"],
  model: "provider/model",
  thinking: "low" as const,
  systemPromptMode: "append" as const,
  systemPrompt: "Scout carefully.",
  autoExit: true,
  filePath: "/agents/scout.md",
};

test("agent discovery can be replaced without touching the filesystem", async () => {
  const calls: Array<readonly [string, boolean]> = [];
  const testLayer = Layer.succeed(
    AgentDiscovery,
    AgentDiscovery.of({
      discover: (cwd, includeProjectAgents) => {
        calls.push([cwd, includeProjectAgents]);
        return Effect.succeed([agent]);
      },
    }),
  );

  const result = await Effect.runPromise(
    discoverAgents("/project", true).pipe(Effect.provide(testLayer)),
  );

  assert.deepEqual(result, [agent]);
  assert.deepEqual(calls, [["/project", true]]);
});

test("runs interactively without replacing the pane shell", () => {
  assert.equal(
    herdrCommandLine("/path with spaces/pi", ["--name", "Scout's pane"]),
    "'/path with spaces/pi' '--name' 'Scout'\\''s pane'",
  );
});

test("sends only a single-line script command through the pane terminal", () => {
  assert.equal(herdrScriptCommand("/tmp/path with spaces.sh"), "bash '/tmp/path with spaces.sh'");
  assert.equal(herdrScriptCommand("/tmp/path with spaces.sh").includes("\n"), false);
});

test("closes an auto-exit pane only after a successful child exit", () => {
  const command = herdrCommandLine("pi", ["task"], "w1:p2");
  assert.match(command, /^'pi' 'task'; status=\$\?;/);
  assert.match(command, /then herdr pane close 'w1:p2'/);
  assert.match(command, /pane kept open for inspection/);
});

test("reads and removes a validated child result", async () => {
  const resultPath = join(tmpdir(), `pi-subagent-result-test-${randomUUID()}.json`);
  setTimeout(
    () => void writeFile(resultPath, JSON.stringify({ text: "done", isError: false })),
    10,
  );

  const result = await Effect.runPromise(
    watchSubagentResult(resultPath, new AbortController().signal).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

  assert.deepEqual(result, { text: "done", isError: false });
  await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(resultPath)));
});

test("reports only the settled child result after retry or recovery", async () => {
  const resultPath = join(tmpdir(), `pi-subagent-settled-test-${randomUUID()}.json`);
  const previousPath = process.env.PI_SUBAGENT_RESULT_PATH;
  process.env.PI_SUBAGENT_RESULT_PATH = resultPath;
  const handlers = new Map<
    string,
    (event: AgentEndEvent | AgentSettledEvent, ctx: ExtensionContext) => unknown
  >();
  let shutdowns = 0;
  // Only the event registration and shutdown APIs are used by this extension.
  const pi = {
    on: (
      name: string,
      handler: (event: AgentEndEvent | AgentSettledEvent, ctx: ExtensionContext) => unknown,
    ) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  const ctx = { shutdown: () => shutdowns++ } as unknown as ExtensionContext;
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    stopReason: "error",
    errorMessage: "Temporary failure",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };

  try {
    subagentChild(pi);
    const end = handlers.get("agent_end")!;
    const settled = handlers.get("agent_settled")!;
    await end({ type: "agent_end", messages: [message] }, ctx);
    await assert.rejects(access(resultPath));
    assert.equal(shutdowns, 0);

    await end(
      {
        type: "agent_end",
        messages: [
          { ...message, stopReason: "stop", content: [{ type: "text", text: "Recovered" }] },
        ],
      },
      ctx,
    );
    await assert.rejects(access(resultPath));
    await settled({ type: "agent_settled" }, ctx);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
      text: "Recovered",
      isError: false,
    });
    assert.equal(shutdowns, 1);
    await rm(resultPath);

    await end({ type: "agent_end", messages: [message] }, ctx);
    await settled({ type: "agent_settled" }, ctx);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
      text: "Temporary failure",
      isError: true,
    });
    assert.equal(shutdowns, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PI_SUBAGENT_RESULT_PATH;
    else process.env.PI_SUBAGENT_RESULT_PATH = previousPath;
    await rm(resultPath, { force: true });
    await rm(`${resultPath}.tmp`, { force: true });
  }
});

test("maps agent frontmatter to an isolated Pi invocation", () => {
  assert.deepEqual(agentArguments(agent, "Scout: Auth", "Analyze auth module"), [
    "--name",
    "Scout: Auth",
    "--no-session",
    "--extension",
    CHILD_EXTENSION_PATH,
    "--model",
    "provider/model",
    "--thinking",
    "low",
    "--tools",
    "read,grep",
    "--append-system-prompt",
    "Scout carefully.",
    "--",
    "Analyze auth module",
  ]);
});
