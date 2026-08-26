import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentDefinition,
  AgentSnapshot,
  RunningAgent,
  ToolActivity,
  WaitOutcome,
} from "./types.ts";

const BUILTIN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
]);
const WEB_TOOLS = new Set(["web_search", "fetch_content", "source_check", "get_search_content"]);
const WEB_ACCESS_EXTENSION = join(
  getAgentDir(),
  "npm",
  "node_modules",
  "pi-web-access",
  "index.ts",
);
const EXTENSION_DIRECTORY =
  typeof __dirname === "string" ? __dirname : join(process.cwd(), "extensions", "subagent");
const SUBAGENT_EXTENSION = join(EXTENSION_DIRECTORY, "index.ts");
const MAX_TRANSCRIPT_ENTRIES = 8;
const MAX_PREVIEW_LENGTH = 120;
const MAX_STDERR_LENGTH = 64 * 1024;

function piCommand(): { command: string; args: string[] } {
  const entry = process.argv[1];
  const isBunVirtualEntry = entry?.startsWith("/$bunfs/root/");
  if (entry && !isBunVirtualEntry && existsSync(entry)) {
    return { command: process.execPath, args: [entry] };
  }

  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args: [] }
    : { command: process.execPath, args: [] };
}

/** Decode arbitrary UTF-8 chunks and frame only on LF (including split codepoints). */
export function decodeJsonlChunks(chunks: readonly Uint8Array[]): string[] {
  const decoder = new StringDecoder("utf8");
  const lines: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    buffer += decoder.write(chunk);
    const complete = buffer.split("\n");
    buffer = complete.pop() ?? "";
    lines.push(...complete);
  }
  buffer += decoder.end();
  if (buffer) lines.push(buffer);
  return lines;
}

export function effectiveSubagentAgents(
  requested: readonly string[],
  inherited = process.env.PI_SUBAGENT_ALLOWED,
): string[] {
  if (inherited === undefined) return [...requested];
  const allowed = new Set(
    inherited
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return requested.filter((name) => allowed.has(name));
}

function writeTemporaryFile(
  prefix: string,
  filename: string,
  value: string,
): {
  directory: string;
  path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = join(directory, filename);
  try {
    writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
    return { directory, path };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function boundedOutput(value: string): string {
  const truncated = truncateHead(value, {
    maxBytes: DEFAULT_MAX_BYTES - 512,
    maxLines: DEFAULT_MAX_LINES - 2,
  });
  if (!truncated.truncated) return value;

  let path: string | undefined;
  try {
    path = writeTemporaryFile("pi-subagent-output-", "output.txt", value).path;
  } catch {
    // The bounded inline result is still safe when preserving the full output fails.
  }
  const suffix = path ? ` Full output saved to: ${path}` : " Full output could not be saved.";
  const notice = `[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}).${suffix}]`;
  const content = truncated.firstLineExceedsLimit
    ? Buffer.from(value, "utf8")
        .subarray(0, DEFAULT_MAX_BYTES - Buffer.byteLength(notice) - 4)
        .toString("utf8")
    : truncated.content;
  return `${content}\n\n${notice}`;
}

function shorten(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_PREVIEW_LENGTH
    ? `${compact.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
    : compact;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function rpcFailure(event: unknown): string | undefined {
  const values = record(event);
  if (!values) return undefined;
  if (values.type === "response" && values.command === "prompt" && values.success === false) {
    return typeof values.error === "string" ? values.error : "Prompt failed";
  }
  if (values.type === "message_end") {
    const message = record(values.message);
    if (message?.stopReason === "error" || message?.stopReason === "aborted") {
      return typeof message.errorMessage === "string" && message.errorMessage
        ? message.errorMessage
        : `Subagent stopped: ${message.stopReason}`;
    }
  }
  if (values.type === "error") {
    return typeof values.error === "string" ? values.error : "Subagent failed";
  }
  return undefined;
}

function toolArgsPreview(args: unknown): string {
  const values = record(args);
  for (const key of ["path", "command", "query", "url", "pattern", "agent", "task"]) {
    if (typeof values?.[key] === "string") return shorten(values[key]);
  }
  if (args === undefined) return "";
  const json = JSON.stringify(args);
  return json ? shorten(json) : "";
}

function transcriptLine(activity: ToolActivity): string {
  const marker = activity.status === "running" ? "▶" : activity.status === "failed" ? "✗" : "✓";
  return `${marker} ${activity.tool}${activity.args ? ` ${activity.args}` : ""}`;
}

export function snapshotOf(agent: RunningAgent): AgentSnapshot {
  return {
    id: agent.id,
    agent: agent.definition.name,
    status: agent.status,
    transcript: agent.transcript.map(transcriptLine),
    toolCount: agent.toolCount,
    durationMs: Date.now() - agent.startedAt,
    usage: { ...agent.usage },
    ...(agent.lastMessage ? { lastMessage: agent.lastMessage } : {}),
    ...(agent.output ? { output: agent.output } : {}),
    ...(agent.error ? { error: agent.error } : {}),
  };
}

export function progressText(snapshot: AgentSnapshot): string {
  const lines = [`${snapshot.id} · ${snapshot.agent} · ${snapshot.status}`];
  lines.push(...(snapshot.transcript.length ? snapshot.transcript : ["(no tool calls yet)"]));
  if (snapshot.error) lines.push(`Error: ${snapshot.error}`);
  return lines.join("\n");
}

function emit(agent: RunningAgent): void {
  const snapshot = snapshotOf(agent);
  for (const listener of agent.listeners) {
    try {
      listener(snapshot);
    } catch {
      // A progress renderer must not affect the child process.
    }
  }
}

function addToolStart(agent: RunningAgent, event: Record<string, unknown>): void {
  agent.toolCount++;
  agent.transcript.push({
    tool: typeof event.toolName === "string" ? event.toolName : "tool",
    args: toolArgsPreview(event.args),
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
    status: "running",
  });
  if (agent.transcript.length > MAX_TRANSCRIPT_ENTRIES) agent.transcript.shift();
  emit(agent);
}

function markToolDone(agent: RunningAgent, event: Record<string, unknown>): void {
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
  const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
  let index = -1;
  if (toolCallId) {
    index = agent.transcript.findIndex((activity) => activity.toolCallId === toolCallId);
  } else {
    for (let i = agent.transcript.length - 1; i >= 0; i--) {
      const activity = agent.transcript[i];
      if (activity.status === "running" && activity.tool === toolName) {
        index = i;
        break;
      }
    }
  }
  if (index >= 0) {
    agent.transcript[index].status = event.isError === true ? "failed" : "done";
    emit(agent);
  }
}

function assistantText(message: unknown): string {
  const values = record(message);
  if (!values || values.role !== "assistant") return "";
  if (typeof values.content === "string") return values.content;
  if (!Array.isArray(values.content)) return "";
  return values.content
    .flatMap((part): string[] => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

function buildArguments(
  agent: AgentDefinition,
  promptPath: string,
  delegatedAgents: readonly string[],
): string[] {
  const allowedTools: string[] = [];
  const extensions: string[] = [];
  for (const tool of agent.tools) {
    if (BUILTIN_TOOLS.has(tool)) {
      allowedTools.push(tool);
    } else if (WEB_TOOLS.has(tool) && existsSync(WEB_ACCESS_EXTENSION)) {
      allowedTools.push(tool);
      if (!extensions.includes(WEB_ACCESS_EXTENSION)) extensions.push(WEB_ACCESS_EXTENSION);
    } else if (tool === "subagent" && delegatedAgents.length > 0) {
      allowedTools.push(tool);
      if (!extensions.includes(SUBAGENT_EXTENSION)) extensions.push(SUBAGENT_EXTENSION);
    }
  }

  const command = piCommand();
  return [
    ...command.args,
    "--mode",
    "rpc",
    "--no-session",
    "--no-skills",
    "--no-extensions",
    allowedTools.length ? "--tools" : "--no-tools",
    ...(allowedTools.length ? [allowedTools.join(",")] : []),
    ...extensions.flatMap((extension) => ["--extension", extension]),
    ...(agent.model ? ["--model", agent.model] : []),
    ...(agent.thinking ? ["--thinking", agent.thinking] : []),
    "--append-system-prompt",
    promptPath,
  ];
}

export function startAgent(
  agent: AgentDefinition,
  task: string,
  cwd: string,
  id: string,
): RunningAgent {
  const command = piCommand();
  const delegatedAgents = effectiveSubagentAgents(agent.subagentAgents ?? []);
  const promptFile = writeTemporaryFile("pi-subagent-prompt-", "prompt.md", agent.prompt);
  const args = buildArguments(agent, promptFile.path, delegatedAgents);
  let promptFileRemoved = false;
  const removePromptFile = (): void => {
    if (promptFileRemoved) return;
    promptFileRemoved = true;
    try {
      rmSync(promptFile.directory, { recursive: true, force: true });
    } catch {
      // The operating system also cleans temporary files eventually.
    }
  };
  const child = (() => {
    try {
      return spawn(command.command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_SUBAGENT_CHILD: "1",
          ...(agent.subagentAgents || process.env.PI_SUBAGENT_ALLOWED !== undefined
            ? { PI_SUBAGENT_ALLOWED: delegatedAgents.join(",") }
            : {}),
        },
      });
    } catch (error) {
      removePromptFile();
      throw error;
    }
  })();

  let output = "";
  let stderr = "";
  let buffer = "";
  let settled = false;
  let resolveDone!: (value: string) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });
  const running: RunningAgent = {
    id,
    definition: agent,
    process: child,
    output,
    status: "running",
    transcript: [],
    toolCount: 0,
    listeners: new Set(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    waiting: false,
    notified: false,
    collected: false,
    reattachmentQueued: false,
    startedAt: Date.now(),
    done,
    resolve: resolveDone,
    reject: rejectDone,
  };

  const complete = (value: string): void => {
    if (settled) return;
    settled = true;
    running.output = boundedOutput(value || "(no output)");
    running.status = "completed";
    emit(running);
    running.resolve(running.output);
    child.kill("SIGTERM");
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    running.error = error.message;
    running.status = "failed";
    emit(running);
    running.reject(error);
    child.kill("SIGTERM");
  };

  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      const event = record(JSON.parse(line));
      if (!event) return;
      if (event.type === "response" && event.command === "prompt") removePromptFile();
      const failure = rpcFailure(event);
      if (failure) {
        fail(new Error(failure));
        return;
      }
      if (event.type === "tool_execution_start") addToolStart(running, event);
      if (event.type === "tool_execution_end") markToolDone(running, event);
      if (event.type === "message_end") {
        const text = assistantText(event.message);
        const usage = record(event.message)?.usage;
        if (record(usage)) {
          const values = record(usage);
          running.usage.turns++;
          running.usage.input += typeof values?.input === "number" ? values.input : 0;
          running.usage.output += typeof values?.output === "number" ? values.output : 0;
          running.usage.cacheRead += typeof values?.cacheRead === "number" ? values.cacheRead : 0;
          running.usage.cacheWrite +=
            typeof values?.cacheWrite === "number" ? values.cacheWrite : 0;
          const cost = record(values?.cost);
          running.usage.cost += typeof cost?.total === "number" ? cost.total : 0;
        }
        if (text) {
          output = boundedOutput(text);
          running.output = output;
          running.lastMessage = shorten(text);
        }
      }
      // agent_end only closes one low-level run. agent_settled means retries,
      // compaction, and queued follow-ups are all finished.
      if (event.type === "agent_settled") complete(output);
    } catch {
      // Ignore non-JSON diagnostics on stdout.
    }
  };

  const decoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${stderrDecoder.write(chunk)}`.slice(-MAX_STDERR_LENGTH);
  });
  child.stdin.on("error", fail);
  child.on("error", fail);
  child.on("close", (code) => {
    removePromptFile();
    buffer += decoder.end();
    stderr = `${stderr}${stderrDecoder.end()}`.slice(-MAX_STDERR_LENGTH);
    if (buffer) handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    if (settled) return;
    if (code === 0) complete(output);
    else fail(new Error(stderr.trim() || `Subagent exited with code ${code ?? 1}`));
  });

  try {
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: `Task:\n${task}` })}\n`);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }
  return running;
}

export function steerAgent(agent: RunningAgent, message: string): void {
  if (!agent.process.stdin.writable || agent.process.stdin.writableEnded) {
    throw new Error(`Agent ${agent.id} is no longer accepting steering messages`);
  }
  agent.process.stdin.write(`${JSON.stringify({ type: "steer", message })}\n`);
}

export function waitForAgent(
  agent: RunningAgent,
  signal: AbortSignal | undefined,
  shouldRelease: () => boolean,
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (timer) clearInterval(timer);
      signal?.removeEventListener("abort", releaseForAbort);
    };
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const releaseForAbort = (): void => finish({ kind: "released", reason: "aborted" });
    const releaseForPendingMessage = (): void =>
      finish({ kind: "released", reason: "pending_message" });

    signal?.addEventListener("abort", releaseForAbort, { once: true });
    if (signal?.aborted) {
      releaseForAbort();
      return;
    }
    if (shouldRelease()) {
      releaseForPendingMessage();
      return;
    }

    timer = setInterval(() => {
      if (shouldRelease()) releaseForPendingMessage();
    }, 100);
    agent.done.then(
      (output) => finish({ kind: "finished", output }),
      (error: unknown) => finish({ kind: "failed", error }),
    );
  });
}
