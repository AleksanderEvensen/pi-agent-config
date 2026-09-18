import { NodeFileSystem } from "@effect/platform-node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Effect, Layer } from "effect";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FramedWidget } from "../../lib/framed-widget.ts";
import subagentChild from "./agent-extension/index.ts";
import { AgentDiscovery, discoverAgents } from "./agents.ts";
import { createRunArchive, updateRunMetadata } from "./history.ts";
import subagents, {
  agentArguments,
  CHILD_EXTENSION_PATH,
  deliveredSubagentRunIds,
  extensionPathsForTools,
  formatElapsed,
  uniqueSubagentName,
  validateAgentConfigurations,
  waitForSubagentResultOrExit,
  watchSubagentResult,
} from "./index.ts";
import { herdrCommandLine, herdrScriptCommand } from "./mux/herdr.ts";
import { readSubagentStatus, writeSubagentStatus } from "./status.ts";

function testDouble<T, V = unknown>(value: V): T {
  // SAFETY: test doubles intentionally implement only the members exercised by each test.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  return value as unknown as T;
}

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

function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    stopReason,
    errorMessage,
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
}

test("assigns stable unique names for parallel subagents", () => {
  assert.equal(uniqueSubagentName("scout", new Set()), "scout");
  assert.equal(uniqueSubagentName("scout", new Set(["scout", "scout-2"])), "scout-3");
});

test("detects subagent results once they enter the parent context", () => {
  const messages = testDouble<Parameters<typeof deliveredSubagentRunIds>[0]>([
    {
      role: "custom",
      customType: "subagent_result",
      content: "done",
      display: true,
      details: { runId: "run-1" },
      timestamp: Date.now(),
    },
    {
      role: "custom",
      customType: "other",
      content: "ignore",
      display: true,
      details: { runId: "run-2" },
      timestamp: Date.now(),
    },
  ]);

  assert.deepEqual(deliveredSubagentRunIds(messages), ["run-1"]);
});

test("framed widgets stay within their requested width", () => {
  const widget = new FramedWidget((innerWidth) => ({
    title: "Subagents",
    rightTitle: "2 running",
    lines: ["x".repeat(innerWidth + 20)],
  }));

  for (const width of [4, 7, 20, 60]) {
    const lines = widget.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
  }

  assert.equal(formatElapsed(0, 65_000), "01:05");
});

test("live status files are atomically readable", async () => {
  const path = join(tmpdir(), `pi-subagent-status-test-${randomUUID()}.json`);

  try {
    await writeSubagentStatus(path, "active", "bash: pnpm run typecheck");
    const status = await readSubagentStatus(path);

    assert.equal(status?.state, "active");
    assert.equal(status?.stage, "bash: pnpm run typecheck");
  } finally {
    await rm(path, { force: true });
    await rm(`${path}.tmp`, { force: true });
  }
});

test("agent discovery can be replaced without touching the filesystem", async () => {
  const calls: Array<readonly [string, boolean]> = [];

  const testLayer = Layer.succeed(
    AgentDiscovery,
    AgentDiscovery.of({
      discover: (cwd, includeProjectAgents) => {
        calls.push([cwd, includeProjectAgents]);

        return Effect.succeed({ agents: [agent], invalid: [] });
      },
    }),
  );

  const result = await Effect.runPromise(
    discoverAgents("/project", true).pipe(Effect.provide(testLayer)),
  );

  assert.deepEqual(result, [agent]);
  assert.deepEqual(calls, [["/project", true]]);
});

test("invalid model and tool configurations are excluded from selection", () => {
  const result = validateAgentConfigurations(
    {
      agents: [
        agent,
        { ...agent, name: "bad-model", model: "provider/missing", filePath: "/bad-model.md" },
        { ...agent, name: "bad-tool", tools: ["missing"], filePath: "/bad-tool.md" },
        { ...agent, name: "inherits", model: undefined, filePath: "/inherits.md" },
      ],
      invalid: [{ filePath: "/broken.md", reason: "invalid frontmatter" }],
    },
    [{ provider: "provider", id: "model" }],
    new Set(["read", "grep"]),
  );

  assert.deepEqual(
    result.agents.map(({ name }) => name),
    ["scout"],
  );
  assert.deepEqual(
    result.invalid.map(({ name, filePath }) => [name, filePath]),
    [
      [undefined, "/broken.md"],
      ["bad-model", "/bad-model.md"],
      ["bad-tool", "/bad-tool.md"],
      ["inherits", "/inherits.md"],
    ],
  );
  assert.match(result.invalid[1].reason, /model .* is not available/);
  assert.match(result.invalid[2].reason, /tools are not available: missing/);
  assert.match(result.invalid[3].reason, /model is required/);
});

test("reload-agents refreshes valid configurations and shows their source paths", async () => {
  const previousHerdrEnv = process.env.HERDR_ENV;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/tmp/test-herdr.sock";
  process.env.HERDR_PANE_ID = "w1:p1";

  type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

  type ShutdownHandler = (event: SessionShutdownEvent, ctx: ExtensionContext) => void;

  const commands = new Map<string, CommandHandler>();
  const registeredTools = new Set<string>();
  let shutdown: ShutdownHandler | undefined;
  let activeTools = ["read"];
  let widgetLines: string[] = [];

  const configuredTools = [
    "read",
    "grep",
    "find",
    "ls",
    "write",
    "edit",
    "bash",
    "web_search",
    "fetch_content",
    "source_check",
    "get_search_content",
  ];

  // SAFETY: this test double implements only the API members exercised here.
  const pi = testDouble<ExtensionAPI>({
    registerTool: (tool: { name: string }) => registeredTools.add(tool.name),
    registerCommand: (name: string, options: { handler: CommandHandler }) =>
      commands.set(name, options.handler),
    on: (name: string, handler: ShutdownHandler) => {
      if (name === "session_shutdown") shutdown = handler;
    },
    getAllTools: () => configuredTools.map((name) => ({ name })),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    // SAFETY: this test double implements only the API members exercised here.
  });

  // SAFETY: this test double implements only the context members exercised here.
  const ctx = testDouble<ExtensionCommandContext>({
    cwd: "/home/alekshse",
    isProjectTrusted: () => false,
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "openai-codex", id: "gpt-5.6-sol" },
        { provider: "openai-codex", id: "gpt-6-sol" },
      ],
    },
    ui: {
      setWidget: (_id: string, value: string[] | undefined) => {
        if (value) widgetLines = value;
      },
      notify: () => {},
    },
    // SAFETY: this test double implements only the context members exercised here.
  });

  try {
    subagents(pi);
    const reload = commands.get("reload-agents");
    assert.ok(reload);
    await reload("", ctx);

    assert.match(widgetLines[0], /3 valid, 0 invalid/);
    assert.ok(widgetLines.some((line) => line.includes("worker — openai-codex/gpt-5.6-sol")));
    assert.ok(widgetLines.some((line) => line.includes("agents/worker.md")));
    assert.ok(activeTools.includes("subagent"));
    assert.ok(activeTools.includes("subagent_message"));
    assert.ok(activeTools.includes("subagent_history"));
    assert.ok(registeredTools.has("subagent_message"));
    shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;

    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;

    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  }
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

test("reports a child process that exits without producing a result", async () => {
  await assert.rejects(
    waitForSubagentResultOrExit(
      new Promise(() => {}),
      Promise.resolve({ paneId: "w1:p2", reason: "process-exited" }),
      0,
    ),
    /process in w1:p2 exited before producing a result/,
  );
});

test("reads a validated child result without deleting the recovery copy", async () => {
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
  await access(resultPath);
  await rm(resultPath);
});

test("creates and updates a durable run archive", async () => {
  const archive = await createRunArchive({
    parentSessionId: "parent-session",
    name: "Scout: Archive",
    agent: "scout",
    task: "Inspect persistence",
  });

  try {
    const initial = JSON.parse(await readFile(archive.metadataPath, "utf8"));
    assert.equal(initial.runId, archive.runId);
    assert.equal(initial.status, "starting");
    assert.equal(initial.transcriptPath, archive.transcriptPath);
    const liveStatus = JSON.parse(await readFile(archive.statusPath, "utf8"));
    assert.equal(liveStatus.version, 1);
    assert.equal(liveStatus.state, "starting");
    assert.equal(liveStatus.stage, "launching");

    await updateRunMetadata(archive.metadataPath, { status: "running", paneId: "w1:p2" });

    const updated = JSON.parse(await readFile(archive.metadataPath, "utf8"));
    assert.equal(updated.status, "running");
    assert.equal(updated.paneId, "w1:p2");
    assert.equal(updated.parentSessionId, "parent-session");
  } finally {
    await rm(archive.directory, { recursive: true, force: true });
  }
});

test("archives messages and reports the final settled assistant response", async () => {
  // SAFETY: the following test double implements only the event API exercised here.
  const id = randomUUID();
  const resultPath = join(tmpdir(), `pi-subagent-result-test-${id}.json`);
  const transcriptPath = join(tmpdir(), `pi-subagent-transcript-test-${id}.jsonl`);
  const previousResultPath = process.env.PI_SUBAGENT_RESULT_PATH;
  const previousTranscriptPath = process.env.PI_SUBAGENT_TRANSCRIPT_PATH;
  const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
  process.env.PI_SUBAGENT_RESULT_PATH = resultPath;
  process.env.PI_SUBAGENT_TRANSCRIPT_PATH = transcriptPath;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";

  type ChildEvent = AgentEndEvent | AgentSettledEvent | MessageEndEvent;

  const handlers = new Map<string, (event: ChildEvent, ctx: ExtensionContext) => void>();
  let shutdowns = 0;

  // SAFETY: this test double implements only the API members exercised here.
  const pi = testDouble<ExtensionAPI>({
    on: (name: string, handler: (event: ChildEvent, ctx: ExtensionContext) => void) =>
      handlers.set(name, handler),
    // SAFETY: this test double implements only the API members exercised here.
  });

  // SAFETY: this test double implements only shutdown, which is the sole member used here.
  // SAFETY: this test double implements only the context members exercised here.
  const ctx = testDouble<ExtensionContext>({ shutdown: () => shutdowns++ });
  const intermediate = assistant("Working", "toolUse");
  const final = assistant("Recovered final report");

  try {
    subagentChild(pi);
    await handlers.get("message_end")!({ type: "message_end", message: intermediate }, ctx);
    await handlers.get("message_end")!({ type: "message_end", message: final }, ctx);
    await handlers.get("agent_end")!({ type: "agent_end", messages: [intermediate, final] }, ctx);
    await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);

    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
      text: "Recovered final report",
      isError: false,
    });

    const records = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 2);
    assert.equal(records[0].index, 0);
    assert.equal(records[1].message.content[0].text, "Recovered final report");
    assert.equal(shutdowns, 1);
  } finally {
    if (previousResultPath === undefined) delete process.env.PI_SUBAGENT_RESULT_PATH;
    else process.env.PI_SUBAGENT_RESULT_PATH = previousResultPath;

    if (previousTranscriptPath === undefined) delete process.env.PI_SUBAGENT_TRANSCRIPT_PATH;
    else process.env.PI_SUBAGENT_TRANSCRIPT_PATH = previousTranscriptPath;

    if (previousAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
    else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
    await rm(resultPath, { force: true });
    await rm(`${resultPath}.tmp`, { force: true });
    await rm(transcriptPath, { force: true });
  }
});

test("reports an empty terminal response as an error with substantive fallback text", async () => {
  // SAFETY: the following test double implements only the event API exercised here.
  const resultPath = join(tmpdir(), `pi-subagent-result-test-${randomUUID()}.json`);
  const previousResultPath = process.env.PI_SUBAGENT_RESULT_PATH;
  const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
  process.env.PI_SUBAGENT_RESULT_PATH = resultPath;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";

  type ChildEvent = AgentEndEvent | AgentSettledEvent | MessageEndEvent;

  const handlers = new Map<string, (event: ChildEvent, ctx: ExtensionContext) => void>();
  let shutdowns = 0;

  // SAFETY: this test double implements only the API members exercised here.
  const pi = testDouble<ExtensionAPI>({
    on: (name: string, handler: (event: ChildEvent, ctx: ExtensionContext) => void) =>
      handlers.set(name, handler),
    // SAFETY: this test double implements only the API members exercised here.
  });

  // SAFETY: this test double implements only shutdown, which is the sole member used here.
  // SAFETY: this test double implements only the context members exercised here.
  const ctx = testDouble<ExtensionContext>({ shutdown: () => shutdowns++ });
  const substantive = assistant("Partial report", "toolUse");
  const empty = assistant("");

  try {
    subagentChild(pi);
    await handlers.get("message_end")!({ type: "message_end", message: substantive }, ctx);
    await handlers.get("message_end")!({ type: "message_end", message: empty }, ctx);
    await handlers.get("agent_end")!({ type: "agent_end", messages: [substantive, empty] }, ctx);
    await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.isError, true);
    assert.match(result.text, /without a textual final response/);
    assert.match(result.text, /Partial report/);
    assert.equal(shutdowns, 0);
  } finally {
    if (previousResultPath === undefined) delete process.env.PI_SUBAGENT_RESULT_PATH;
    else process.env.PI_SUBAGENT_RESULT_PATH = previousResultPath;

    if (previousAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
    else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
    await rm(resultPath, { force: true });
    await rm(`${resultPath}.tmp`, { force: true });
  }
});

test("isolates extension-backed tools by their registered source path", () => {
  const extensionPath = CHILD_EXTENSION_PATH;

  const tools = [
    {
      name: "read",
      sourceInfo: {
        path: "<builtin:read>",
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
      },
    },
    {
      name: "web_search",
      sourceInfo: {
        path: extensionPath,
        source: "pi-web-access",
        scope: "user",
        origin: "package",
      },
    },
  ];

  assert.deepEqual(extensionPathsForTools(["read", "web_search"], testDouble(tools)), [
    extensionPath,
  ]);
  assert.throws(
    () =>
      extensionPathsForTools(
        ["sdk_tool"],
        testDouble([
          {
            name: "sdk_tool",
            sourceInfo: {
              path: "<sdk:sdk_tool>",
              source: "sdk",
              scope: "temporary",
              origin: "top-level",
            },
          },
        ]),
      ),
    /cannot be isolated/,
  );
});

test("always loads reporting, while auto-exit remains a separate policy", () => {
  const expected = [
    "--name",
    "Scout: Auth",
    "--no-session",
    "--no-extensions",
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
  ];

  assert.deepEqual(agentArguments(agent, "Scout: Auth", "Analyze auth module"), expected);
  assert.deepEqual(
    agentArguments({ ...agent, autoExit: false }, "Scout: Auth", "Analyze auth module"),
    expected,
  );
});
