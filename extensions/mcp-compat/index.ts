import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Predicate, Result, Schema } from "effect";
import { runWithNodeServices } from "../../lib/effect.ts";
import { Entry, McpFile } from "./schema.ts";

export const loadMcpConfig = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const raw = yield* fs
      .readFileString(path)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));

    const servers: (typeof Entry.Type)[] = [];
    const skipped: { name: string; reason: string }[] = [];

    if (raw === undefined) return { servers, skipped };

    const file = yield* Schema.decodeUnknownEffect(McpFile)(raw);

    for (const [name, config] of Object.entries(file.mcpServers)) {
      const entry = Schema.decodeUnknownResult(Entry)({ name, config });

      if (Result.isSuccess(entry)) servers.push(entry.success);
      else skipped.push({ name, reason: entry.failure.message });
    }

    return { servers, skipped };
  });

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const path = join(ctx.cwd, ".mcp.json");
    await runWithNodeServices(
      loadMcpConfig(path).pipe(
        Effect.tap(({ servers, skipped }) =>
          Effect.sync(() => {
            for (const skippedServer of skipped) {
              ctx.ui.notify(
                `Skipped ${path} server ${skippedServer.name}: ${skippedServer.reason}`,
                "warning",
              );
            }

            if (servers.length === 0) return;

            // The local SDK predates this API; check the running host instead of asserting it exists.
            if (!("registerMcpServer" in pi) || !Predicate.isFunction(pi.registerMcpServer)) {
              ctx.ui.notify(
                "Loading .mcp.json requires a Pi version with registerMcpServer support",
                "warning",
              );

              return;
            }

            for (const { name, config } of servers) {
              try {
                pi.registerMcpServer(name, config);
              } catch (cause) {
                ctx.ui.notify(
                  `Could not register ${path} server ${name}: ${String(cause)}`,
                  "warning",
                );
              }
            }
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            ctx.ui.notify(`Could not load ${path}: ${error.message}`, "warning");
          }),
        ),
      ),
    );
  });
}
