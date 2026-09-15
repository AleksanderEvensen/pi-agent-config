import { NodeFileSystem } from "@effect/platform-node";
import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Schema } from "effect";

export const SubagentResult = Schema.Struct({
  text: Schema.String,
  isError: Schema.Boolean,
});

/** Report an autonomous child's final response, then exit after successful runs. */
export default function subagentChild(pi: ExtensionAPI): void {
  let lastRunMessages: AgentEndEvent["messages"] = [];
  pi.on("agent_end", (event) => {
    lastRunMessages = event.messages;
  });

  // A low-level run can end before automatic retries or compaction recovery finish.
  pi.on("agent_settled", async (_event, ctx) => {
    const messages = lastRunMessages;
    lastRunMessages = [];
    const resultPath = process.env.PI_SUBAGENT_RESULT_PATH;
    if (!resultPath) return;

    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (message.stopReason === "aborted") return;

      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const isError = message.stopReason === "error";

      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const temporaryPath = `${resultPath}.tmp`;
          yield* fs.writeFileString(
            temporaryPath,
            JSON.stringify({
              text: text || message.errorMessage || "Subagent exited without a final response.",
              isError,
            }),
            { mode: 0o600 },
          );
          yield* fs.rename(temporaryPath, resultPath);
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );

      if (!isError) ctx.shutdown();
      return;
    }
  });
}
