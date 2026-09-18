import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Schema } from "effect";
import { runWithNodeServices } from "../../../lib/effect.ts";
import { type SubagentLiveState, writeSubagentStatus } from "../status.ts";

export const SubagentResult = Schema.Struct({
  text: Schema.String,
  isError: Schema.Boolean,
});

type AgentMessage = AgentEndEvent["messages"][number];

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function findLastMatching(
  messages: readonly AssistantMessage[],
  predicate: (message: AssistantMessage) => boolean,
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (predicate(messages[index])) return messages[index];
  }

  return undefined;
}

/** Archive an autonomous child's conversation, report its final response, and optionally exit. */
export default function subagentChild(pi: ExtensionAPI): void {
  const resultPath = process.env.PI_SUBAGENT_RESULT_PATH;
  const transcriptPath = process.env.PI_SUBAGENT_TRANSCRIPT_PATH;
  const statusPath = process.env.PI_SUBAGENT_STATUS_PATH;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const assistantMessages: AssistantMessage[] = [];
  let lastRunMessages: AgentEndEvent["messages"] = [];
  let transcriptIndex = 0;
  let transcriptWrites = Promise.resolve();
  let statusWrites = Promise.resolve();

  const reportStatus = (state: SubagentLiveState, stage: string): void => {
    if (!statusPath) return;
    statusWrites = statusWrites
      .catch(() => {})
      .then(() => writeSubagentStatus(statusPath, state, stage));
  };

  pi.on("session_start", () => reportStatus("starting", "starting agent"));
  pi.on("agent_start", () => reportStatus("active", "thinking"));
  pi.on("turn_start", () => reportStatus("active", "thinking"));
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") reportStatus("active", "responding");
  });
  pi.on("tool_execution_start", (event) => {
    const candidate =
      event.args.command ??
      event.args.path ??
      event.args.query ??
      event.args.url ??
      event.args.name;

    const detail = Schema.is(Schema.String)(candidate)
      ? candidate.replaceAll(/\s+/g, " ").trim().slice(0, 80)
      : Schema.is(Schema.Array(Schema.String))(event.args.queries)
        ? event.args.queries.join(", ").slice(0, 80)
        : "";

    reportStatus("active", detail ? `${event.toolName}: ${detail}` : event.toolName);
  });
  pi.on("tool_execution_end", () => reportStatus("active", "thinking"));

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") assistantMessages.push(event.message);

    if (!transcriptPath) return;

    const record = JSON.stringify({
      index: transcriptIndex++,
      timestamp: new Date().toISOString(),
      message: event.message,
    });

    transcriptWrites = transcriptWrites.then(() =>
      runWithNodeServices(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(transcriptPath, `${record}\n`, { flag: "a", mode: 0o600 });
        }),
      ),
    );
  });

  // Keep this as a fallback for hosts that do not emit message_end for restored/final messages.
  pi.on("agent_end", (event) => {
    lastRunMessages = event.messages;
  });

  // A low-level run can end before automatic retries or compaction recovery finish.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!resultPath) return;
    await transcriptWrites;

    const fallbackAssistants = lastRunMessages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );

    const candidates = assistantMessages.length > 0 ? assistantMessages : fallbackAssistants;
    const terminal = findLastMatching(candidates, (message) => message.stopReason !== "aborted");

    if (!terminal) return;

    let text = assistantText(terminal) || terminal.errorMessage || "";
    let isError = terminal.stopReason === "error";

    if (!text) {
      const substantive = findLastMatching(
        candidates,
        (message) => message.stopReason !== "aborted" && assistantText(message).length > 0,
      );

      const fallbackText = substantive ? assistantText(substantive) : "";
      text = fallbackText
        ? `Subagent settled without a textual final response. Last substantive assistant message:\n\n${fallbackText}`
        : "Subagent settled without a textual final response.";
      isError = true;
    }

    reportStatus(isError ? "failed" : "finished", isError ? "failed" : "complete");
    await statusWrites.catch(() => {});

    await runWithNodeServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporaryPath = `${resultPath}.tmp`;
        yield* fs.writeFileString(temporaryPath, JSON.stringify({ text, isError }), {
          mode: 0o600,
        });
        yield* fs.rename(temporaryPath, resultPath);
      }),
    );

    if (autoExit && !isError) ctx.shutdown();
  });
}
