import { NodeFileSystem } from "@effect/platform-node";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Option } from "effect";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { errorMessage } from "../../lib/errors.ts";
import {
  AgentDiscoveryLive,
  discoverAgentConfigurations,
  type AgentConfig,
  type AgentDiscoveryResult,
  type InvalidAgentConfig,
} from "./agents.ts";
import {
  createRunArchive,
  registerHistoryTool,
  updateRunMetadata,
  watchSubagentResult,
} from "./history.ts";
import { detectMux, Mux } from "./mux/index.ts";

export { watchSubagentResult } from "./history.ts";

export const CHILD_EXTENSION_PATH = fileURLToPath(
  new URL("./agent-extension/index.ts", import.meta.url),
);

type ModelIdentity = { readonly provider: string; readonly id: string };

export type ValidatedAgentDiscovery = AgentDiscoveryResult;

export function validateAgentConfigurations(
  discovery: AgentDiscoveryResult,
  availableModels: readonly ModelIdentity[],
  availableTools: ReadonlySet<string>,
): ValidatedAgentDiscovery {
  const agents: AgentConfig[] = [];
  const invalid: InvalidAgentConfig[] = [...discovery.invalid];

  for (const agent of discovery.agents) {
    const reasons: string[] = [];
    if (!agent.model) {
      reasons.push("model is required");
    } else if (
      !availableModels.some(
        (model) => agent.model === model.id || agent.model === `${model.provider}/${model.id}`,
      )
    ) {
      reasons.push(`model ${JSON.stringify(agent.model)} is not available`);
    }
    const missingTools = agent.tools.filter((tool) => !availableTools.has(tool));
    if (missingTools.length > 0)
      reasons.push(`tools are not available: ${missingTools.join(", ")}`);

    if (reasons.length > 0) {
      invalid.push({ filePath: agent.filePath, name: agent.name, reason: reasons.join("; ") });
    } else {
      agents.push(agent);
    }
  }

  return { agents, invalid };
}

const SubagentParameters = Type.Object({
  name: Type.String({ description: "Display name for the spawned agent pane" }),
  agent: Type.String({ description: "Agent name from an agent Markdown file" }),
  task: Type.String({
    description:
      "Self-contained task. Ask the agent to put its complete deliverable in its final response; do not ask a read-only agent to write files.",
  }),
});

function piInvocation(args: readonly string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args: [...args] }
    : { command: process.execPath, args: [...args] };
}

export function agentArguments(agent: AgentConfig, name: string, task: string): string[] {
  const args = ["--name", name, "--no-session", "--extension", CHILD_EXTENSION_PATH];
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  if (agent.systemPrompt) {
    args.push(
      agent.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      agent.systemPrompt,
    );
  }
  args.push("--", task);
  return args;
}

function registerSubagentTool(
  pi: ExtensionAPI,
  muxLayer: Layer.Layer<Mux>,
  getDiscovery: (ctx: ExtensionContext) => Promise<ValidatedAgentDiscovery>,
  watchers: Set<AbortController>,
): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn a specialist in a new split pane and return immediately with a run ID; this tool does not return the specialist's report.",
      "The complete final response is delivered later as a follow-up message, and the full conversation is archived for subagent_history recovery.",
      "After spawning, do not poll panes or temporary files. Continue other useful work or end the turn and wait for completion messages.",
      "Only agents whose model and tools passed the latest discovery validation can be selected. Use /reload-agents after editing agent files.",
    ].join(" "),
    parameters: SubagentParameters,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();

      const discovery = await getDiscovery(ctx);
      const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
      if (!agent) {
        const invalid = discovery.invalid.find((candidate) => candidate.name === params.agent);
        const available = discovery.agents
          .map(({ name, description }) => `${name}: ${description}`)
          .join("; ");
        throw new Error(
          invalid
            ? `Agent ${JSON.stringify(params.agent)} is invalid: ${invalid.reason} (${invalid.filePath})`
            : `Unknown agent ${JSON.stringify(params.agent)}. Available agents: ${available || "none"}`,
        );
      }

      const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
      const missingTools = agent.tools.filter((tool) => !availableTools.has(tool));
      if (missingTools.length > 0) {
        throw new Error(
          `Agent ${JSON.stringify(agent.name)} requests unavailable tools: ${missingTools.join(", ")}`,
        );
      }

      const { runId, metadataPath, transcriptPath, resultPath } = await createRunArchive({
        parentSessionId: ctx.sessionManager.getSessionId(),
        name: params.name,
        agent: agent.name,
        task: params.task,
      });

      const invocation = piInvocation(agentArguments(agent, params.name, params.task));
      let result: { paneId: string };
      try {
        result = await Effect.runPromise(
          Effect.gen(function* () {
            const mux = yield* Mux;
            return yield* mux.spawn({
              name: params.name,
              cwd: ctx.cwd,
              command: invocation.command,
              args: invocation.args,
              environment: {
                PI_SUBAGENT_RESULT_PATH: resultPath,
                PI_SUBAGENT_TRANSCRIPT_PATH: transcriptPath,
                PI_SUBAGENT_AUTO_EXIT: agent.autoExit ? "1" : "0",
              },
              closeOnExit: agent.autoExit,
            });
          }).pipe(Effect.provide(muxLayer)),
        );
      } catch (error) {
        await updateRunMetadata(metadataPath, {
          status: "failed",
          error: errorMessage(error),
        });
        throw error;
      }
      await updateRunMetadata(metadataPath, { status: "running", paneId: result.paneId });

      const watcher = new AbortController();
      watchers.add(watcher);
      void Effect.runPromise(
        watchSubagentResult(resultPath, watcher.signal).pipe(Effect.provide(NodeFileSystem.layer)),
      )
        .then((childResult) => {
          const deliveryQueuedAt = new Date().toISOString();
          void updateRunMetadata(metadataPath, {
            status: childResult.isError ? "failed" : "finished",
            isError: childResult.isError,
            deliveryQueuedAt,
          }).catch(() => {});
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: [
                `Subagent ${JSON.stringify(params.name)} ${childResult.isError ? "failed" : "finished"} (run ${runId}):`,
                childResult.text,
                `Archived conversation: ${transcriptPath}`,
                `Use subagent_history with runId ${runId} to inspect or recover messages.`,
              ].join("\n\n"),
              display: true,
              details: {
                runId,
                paneId: result.paneId,
                agent: agent.name,
                name: params.name,
                isError: childResult.isError,
                transcriptPath,
                resultPath,
              },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        })
        .catch((error: unknown) => {
          if (watcher.signal.aborted) return;
          const message = errorMessage(error);
          void updateRunMetadata(metadataPath, { status: "failed", error: message }).catch(
            () => {},
          );
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: [
                `Could not read the result from subagent ${JSON.stringify(params.name)} (run ${runId}): ${message}`,
                `Its archived conversation may still be available at ${transcriptPath}.`,
                `Use subagent_history with runId ${runId} to inspect it.`,
              ].join("\n\n"),
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        })
        .finally(() => watchers.delete(watcher));

      return {
        content: [
          {
            type: "text",
            text: [
              `Spawned ${params.name} (${agent.name}) in ${result.paneId}.`,
              `Run ID: ${runId}`,
              "This is only a spawn receipt. The report will arrive asynchronously as a follow-up message.",
              "Do not poll the pane or transcript; continue useful work or end the turn.",
              `Recovery: subagent_history can inspect ${transcriptPath}`,
            ].join("\n"),
          },
        ],
        details: {
          runId,
          paneId: result.paneId,
          mux: "herdr",
          agent: agent.name,
          name: params.name,
          autoExit: agent.autoExit,
          transcriptPath,
          resultPath,
        },
      };
    },
  });
}

export default function subagents(pi: ExtensionAPI): void {
  const muxLayer = Option.getOrUndefined(detectMux());
  if (!muxLayer) return;

  const widgetId = "subagent-discovery";
  let subagentRegistered = false;
  let discovery: ValidatedAgentDiscovery | undefined;
  let widgetTimer: NodeJS.Timeout | undefined;
  const watchers = new Set<AbortController>();

  const refreshDiscovery = async (ctx: ExtensionContext): Promise<ValidatedAgentDiscovery> => {
    const discovered = await Effect.runPromise(
      discoverAgentConfigurations(ctx.cwd, ctx.isProjectTrusted()).pipe(
        Effect.provide(AgentDiscoveryLive),
      ),
    );
    discovery = validateAgentConfigurations(
      discovered,
      ctx.modelRegistry.getAvailable(),
      new Set(pi.getAllTools().map((tool) => tool.name)),
    );
    return discovery;
  };

  const getDiscovery = (ctx: ExtensionContext): Promise<ValidatedAgentDiscovery> =>
    discovery ? Promise.resolve(discovery) : refreshDiscovery(ctx);

  const enableSubagentTools = (): void => {
    if (!subagentRegistered) {
      registerSubagentTool(pi, muxLayer, getDiscovery, watchers);
      subagentRegistered = true;
    }
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "subagent", "subagent_history"])]);
  };

  const reportLines = (result: ValidatedAgentDiscovery): string[] => [
    `Subagents reloaded: ${result.agents.length} valid, ${result.invalid.length} invalid`,
    ...result.agents.map(
      (agent) => `✓ ${agent.name} — ${agent.model ?? "missing model"}\n  ${agent.filePath}`,
    ),
    ...result.invalid.map(
      (agent) =>
        `✗ ${agent.name ?? basename(agent.filePath, ".md")} — ${agent.reason}\n  ${agent.filePath}`,
    ),
  ];

  const showDiscoveryWidget = (ctx: ExtensionContext, result: ValidatedAgentDiscovery): void => {
    if (widgetTimer) clearTimeout(widgetTimer);
    ctx.ui.setWidget(widgetId, reportLines(result));
    widgetTimer = setTimeout(() => {
      ctx.ui.setWidget(widgetId, undefined);
      widgetTimer = undefined;
    }, 10_000);
    widgetTimer.unref();
  };

  pi.on("session_shutdown", (_event, ctx) => {
    for (const watcher of watchers) watcher.abort();
    watchers.clear();
    if (widgetTimer) clearTimeout(widgetTimer);
    widgetTimer = undefined;
    ctx.ui.setWidget(widgetId, undefined);
  });

  registerHistoryTool(pi);

  pi.registerCommand("reload-agents", {
    description:
      "Rediscover agent files, validate their models/tools, and refresh available subagents",
    handler: async (_args, ctx) => {
      const result = await refreshDiscovery(ctx);
      enableSubagentTools();
      showDiscoveryWidget(ctx, result);
      ctx.ui.notify(
        `Reloaded ${result.agents.length} valid agent${result.agents.length === 1 ? "" : "s"}; ${result.invalid.length} invalid`,
        result.invalid.length > 0 ? "warning" : "info",
      );
    },
  });

  pi.registerTool({
    name: "list_subagents",
    label: "List Subagents",
    description:
      "Rediscover and validate specialist agents, then enable asynchronous spawning. Configurations with missing/unknown/unavailable models or tools are reported but cannot be selected.",
    promptSnippet: "Discover and validate asynchronous specialist agents before delegating work",
    promptGuidelines: [
      "Call list_subagents before delegation, then use subagent with an available agent name.",
      "The subagent tool is asynchronous: its immediate result is only a spawn receipt. Never poll panes or temporary files; completion reports arrive as follow-up messages.",
      "Use /reload-agents after an agent configuration changes so future spawns use the new validated configuration.",
      "Use subagent_history to recover a missing result or inspect a child's complete archived conversation.",
      "Ask read-only agents to return their deliverable in the final response instead of writing files.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const result = await refreshDiscovery(ctx);
      enableSubagentTools();

      return {
        content: [
          {
            type: "text",
            text: [
              ...reportLines(result),
              "",
              "Only valid agents are selectable.",
              "Flow: subagent returns a spawn receipt immediately; the report arrives asynchronously as a follow-up message.",
              "Recovery: use subagent_history to list runs or read any archived conversation/message.",
            ].join("\n"),
          },
        ],
        details: {
          agents: result.agents.map(({ name, description, filePath, model }) => ({
            name,
            description,
            filePath,
            model,
          })),
          invalid: result.invalid,
          subagentEnabled: true,
          historyEnabled: true,
        },
      };
    },
  });
}
