import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { decodeJson } from "../../lib/effect.ts";
import { SubagentResult } from "./agent-extension/index.ts";
import { writeSubagentStatus } from "./status.ts";

const RUN_DIRECTORY_PREFIX = "pi-subagent-run-";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RunMetadataSchema = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  parentSessionId: Schema.String,
  name: Schema.String,
  agent: Schema.String,
  task: Schema.String,
  status: Schema.Union([
    Schema.Literal("starting"),
    Schema.Literal("running"),
    Schema.Literal("finished"),
    Schema.Literal("failed"),
  ]),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  directory: Schema.String,
  transcriptPath: Schema.String,
  resultPath: Schema.String,
  paneId: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  deliveryQueuedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export type RunMetadata = Schema.Schema.Type<typeof RunMetadataSchema>;

export type RunArchive = {
  readonly runId: string;
  readonly directory: string;
  readonly metadataPath: string;
  readonly transcriptPath: string;
  readonly resultPath: string;
  readonly statusPath: string;
};

const HistoryParameters = Type.Object({
  action: StringEnum(["list", "read"] as const, {
    description: 'Use "list" to find runs or "read" to inspect one transcript.',
  }),
  runId: Type.Optional(Type.String({ description: "Run ID returned by subagent or history list" })),
  messageIndex: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Read one exact transcript message instead of the full history",
    }),
  ),
});

export const watchSubagentResult = Effect.fn("Subagents.watchResult")(function* (
  resultPath: string,
  signal: AbortSignal,
) {
  const fs = yield* FileSystem.FileSystem;

  while (!signal.aborted) {
    if (yield* fs.exists(resultPath)) {
      return yield* decodeJson(SubagentResult, yield* fs.readFileString(resultPath));
    }

    yield* Effect.sleep("250 millis");
  }

  return yield* Effect.fail(new Error("Subagent result watcher was cancelled"));
});

const TranscriptPartSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Unknown),
});

const TranscriptMessageSchema = Schema.Struct({
  role: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  errorMessage: Schema.optional(Schema.String),
});

const TranscriptRecordSchema = Schema.Struct({
  index: Schema.optional(Schema.Number),
  message: TranscriptMessageSchema,
});

function parseRunMetadata(raw: string): RunMetadata | undefined {
  try {
    return Effect.runSync(decodeJson(RunMetadataSchema, raw));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic<T>(path: string, value: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function createRunArchive({
  parentSessionId,
  name,
  agent,
  task,
}: Pick<RunMetadata, "parentSessionId" | "name" | "agent" | "task">): Promise<RunArchive> {
  const runId = randomUUID();
  const directory = join(tmpdir(), `${RUN_DIRECTORY_PREFIX}${runId}`);
  const metadataPath = join(directory, "metadata.json");
  const transcriptPath = join(directory, "conversation.jsonl");
  const resultPath = join(directory, "result.json");
  const statusPath = join(directory, "status.json");
  const now = new Date().toISOString();

  await mkdir(directory, { mode: 0o700 });
  await writeJsonAtomic(metadataPath, {
    version: 1,
    runId,
    parentSessionId,
    name,
    agent,
    task,
    status: "starting",
    startedAt: now,
    updatedAt: now,
    directory,
    transcriptPath,
    resultPath,
  } satisfies RunMetadata);
  await writeSubagentStatus(statusPath, "starting", "launching");

  return { runId, directory, metadataPath, transcriptPath, resultPath, statusPath };
}

export async function updateRunMetadata(
  metadataPath: string,
  patch: Partial<Omit<RunMetadata, "version" | "runId" | "parentSessionId">>,
): Promise<void> {
  await withFileMutationQueue(metadataPath, async () => {
    const current = parseRunMetadata(await readFile(metadataPath, "utf8"));

    if (!current) throw new Error(`Invalid subagent metadata: ${metadataPath}`);
    await writeJsonAtomic(metadataPath, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    } satisfies RunMetadata);
  });
}

async function listRuns(parentSessionId: string): Promise<RunMetadata[]> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });

  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_DIRECTORY_PREFIX))
      .map(async (entry) => {
        try {
          return parseRunMetadata(
            await readFile(join(tmpdir(), entry.name, "metadata.json"), "utf8"),
          );
        } catch {
          return undefined;
        }
      }),
  );

  return runs
    .filter((run): run is RunMetadata => run?.parentSessionId === parentSessionId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function findRun(parentSessionId: string, runId: string): Promise<RunMetadata | undefined> {
  if (!RUN_ID_PATTERN.test(runId)) return undefined;

  try {
    const run = parseRunMetadata(
      await readFile(join(tmpdir(), `${RUN_DIRECTORY_PREFIX}${runId}`, "metadata.json"), "utf8"),
    );

    return run?.parentSessionId === parentSessionId ? run : undefined;
  } catch {
    return undefined;
  }
}

function valueString<T>(value: T): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function formatTranscriptRecord<T>(record: T): string {
  if (!Schema.is(TranscriptRecordSchema)(record)) return JSON.stringify(record, null, 2);
  const { message } = record;
  const index = record.index ?? "?";
  const role = message.role ?? "unknown";
  const toolName = message.toolName ? ` · ${message.toolName}` : "";
  const stopReason = message.stopReason ? ` · ${message.stopReason}` : "";
  const output = [`## Message ${index} · ${role}${toolName}${stopReason}`];

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!Schema.is(TranscriptPartSchema)(part)) {
        output.push(valueString(part));
        continue;
      }

      if (part.type === "text") output.push(part.text ?? "");
      else if (part.type === "thinking") output.push(`[thinking]\n${part.thinking ?? ""}`);
      else if (part.type === "toolCall") {
        output.push(`[tool call: ${part.name ?? "unknown"}]\n${valueString(part.arguments)}`);
      } else if (part.type === "image") output.push("[image]");
      else output.push(valueString(part));
    }
  }

  if (message.errorMessage !== undefined) output.push(`[error]\n${message.errorMessage}`);

  return output.join("\n\n");
}

async function readTranscript(path: string): Promise<unknown[]> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }

  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [Effect.runSync(decodeJson(Schema.Unknown, line))];
      } catch {
        return [];
      }
    });
}

function truncateHistory(content: string, fullPath: string): string {
  const truncation = truncateHead(content, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) return content;

  return `${truncation.content}\n\n[History truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full JSONL: ${fullPath}]`;
}

export function registerHistoryTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_history",
    label: "Subagent History",
    description:
      "Recover asynchronous subagent runs from durable temporary archives. List runs for this Pi session, read a full conversation, or retrieve one exact message by index. Outputs are truncated at 50KB; the full JSONL path is always reported.",
    promptSnippet: "List or inspect archived asynchronous subagent conversations",
    promptGuidelines: [
      "Use subagent_history instead of polling files or panes when an asynchronous subagent result is missing or more context is needed.",
    ],
    parameters: HistoryParameters,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const parentSessionId = ctx.sessionManager.getSessionId();

      if (params.action === "list") {
        const runs = await listRuns(parentSessionId);

        const text =
          runs.length === 0
            ? "No archived subagent runs exist for this session."
            : runs
                .map(
                  (run) =>
                    `${run.runId}  ${run.status.padEnd(8)}  ${run.agent}  ${JSON.stringify(run.name)}  ${run.startedAt}\n  transcript: ${run.transcriptPath}`,
                )
                .join("\n");

        return { content: [{ type: "text", text }], details: { runs } };
      }

      if (!params.runId) throw new Error('runId is required when action is "read"');
      const run = await findRun(parentSessionId, params.runId);

      if (!run)
        throw new Error(`No subagent run ${JSON.stringify(params.runId)} exists in this session`);
      const records = await readTranscript(run.transcriptPath);

      if (params.messageIndex !== undefined) {
        const record = records.find(
          (candidate) =>
            Schema.is(TranscriptRecordSchema)(candidate) && candidate.index === params.messageIndex,
        );

        if (!record) {
          throw new Error(
            `Message ${params.messageIndex} does not exist in run ${params.runId}; transcript has ${records.length} messages`,
          );
        }

        return {
          content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
          details: { run, messageIndex: params.messageIndex },
        };
      }

      const formatted = records.map(formatTranscriptRecord).join("\n\n---\n\n");

      const text = [
        `Run: ${run.runId}\nName: ${run.name}\nAgent: ${run.agent}\nStatus: ${run.status}\nTask: ${run.task}\nFull JSONL: ${run.transcriptPath}`,
        formatted || "(The child has not recorded any messages yet.)",
      ].join("\n\n");

      return {
        content: [{ type: "text", text: truncateHistory(text, run.transcriptPath) }],
        details: { run, messageCount: records.length },
      };
    },
  });
}
