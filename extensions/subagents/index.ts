import { NodeFileSystem } from "@effect/platform-node";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Effect, Layer, Option, Schema } from "effect";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { errorMessage } from "../../lib/errors.ts";
import { FramedWidget } from "../../lib/framed-widget.ts";
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
import { detectMux, Mux, type ExitResult } from "./mux/index.ts";
import { readSubagentStatus, type SubagentLiveStatus } from "./status.ts";

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
  name: Type.Optional(
    Type.String({
      description:
        "Optional display name. Defaults to the agent name and is automatically made unique.",
    }),
  ),
  agent: Type.String({ description: "Agent name from an agent Markdown file" }),
  task: Type.String({
    description:
      "Self-contained task. Ask the agent to put its complete deliverable in its final response; do not ask a read-only agent to write files.",
  }),
});

type PiInvocation = { command: string; args: string[] };

type ChildResult = { readonly text: string; readonly isError: boolean };

export async function waitForSubagentResultOrExit(
  resultPromise: Promise<ChildResult>,
  exitPromise: Promise<ExitResult>,
  graceMs = 500,
): Promise<ChildResult> {
  const outcome = await Promise.race([
    resultPromise.then((childResult) => ({ type: "result" as const, childResult })),
    exitPromise.then((exit) => ({ type: "exit" as const, exit })),
  ]);

  if (outcome.type === "result") return outcome.childResult;

  const graceResult = await Promise.race([
    resultPromise.then((childResult) => ({ childResult })),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), graceMs)),
  ]);

  if (graceResult) return graceResult.childResult;

  throw new Error(
    outcome.exit.reason === "pane-closed"
      ? `Subagent pane ${outcome.exit.paneId} closed before producing a result`
      : `Subagent process in ${outcome.exit.paneId} exited before producing a result`,
  );
}

const SubagentMessageParameters = Type.Object({
  name: Type.String({ description: "Exact display name of a running subagent" }),
  message: Type.String({ description: "Message to steer into the running subagent" }),
});

const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export function extensionPathsForTools(
  toolNames: readonly string[],
  availableTools: readonly ToolInfo[],
): string[] {
  const paths = new Set<string>();

  for (const name of toolNames) {
    if (BUILTIN_TOOLS.has(name)) continue;
    const tool = availableTools.find((candidate) => candidate.name === name);

    if (!tool) throw new Error(`Tool ${JSON.stringify(name)} is not registered`);

    if (tool.sourceInfo.source === "builtin") continue;

    if (tool.sourceInfo.source === "sdk" || !existsSync(tool.sourceInfo.path)) {
      throw new Error(
        `Tool ${JSON.stringify(name)} cannot be isolated because its extension path is unavailable`,
      );
    }

    paths.add(tool.sourceInfo.path);
  }

  return [...paths];
}

const LIVE_STATUS_COLORS = {
  starting: "muted",
  active: "success",
  waiting: "warning",
  finished: "success",
  failed: "error",
} as const;

type RunningSubagent = {
  readonly runId: string;
  readonly paneId: string;
  readonly name: string;
  readonly agent: string;
  readonly startedAt: number;
  readonly statusPath: string;
  status: SubagentLiveStatus;
  acceptingMessages: boolean;
};

export function uniqueSubagentName(requestedName: string, takenNames: ReadonlySet<string>): string {
  if (!takenNames.has(requestedName)) return requestedName;

  let suffix = 2;

  while (takenNames.has(`${requestedName}-${suffix}`)) suffix++;

  return `${requestedName}-${suffix}`;
}

const DeliveredResultDetails = Schema.Struct({ runId: Schema.String });

export function deliveredSubagentRunIds(messages: ContextEvent["messages"]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "custom" || message.customType !== "subagent_result") return [];

    const details = Schema.decodeUnknownOption(DeliveredResultDetails)(message.details);

    return Option.isSome(details) ? [details.value.runId] : [];
  });
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);

  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderRunningSubagent(run: RunningSubagent, width: number, theme: Theme): string {
  const leftText = `${formatElapsed(run.startedAt)}  ${run.name} (${run.agent})`;
  const statusText = run.status.state;
  const rightText = `${statusText} · ${run.status.stage}`;
  const leftBudget = Math.min(Math.max(1, Math.floor(width * 0.45)), Math.max(1, width - 2));
  const left = truncateToWidth(leftText, leftBudget, "…");
  const remaining = Math.max(1, width - visibleWidth(left) - 1);
  const right = truncateToWidth(rightText, remaining, "…");
  const gap = "·".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));

  const coloredRight = right.startsWith(statusText)
    ? `${theme.fg(LIVE_STATUS_COLORS[run.status.state], statusText)}${theme.fg("muted", right.slice(statusText.length))}`
    : theme.fg("muted", right);

  return `${theme.fg("text", left)}${theme.fg("dim", gap)}${coloredRight}`;
}

function piInvocation(args: readonly string[]): PiInvocation {
  const script = process.argv[1];

  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();

  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args: [...args] }
    : { command: process.execPath, args: [...args] };
}

export function agentArguments(
  agent: AgentConfig,
  name: string,
  task: string,
  toolExtensionPaths: readonly string[] = [],
): string[] {
  const args = [
    "--name",
    name,
    "--no-session",
    "--no-extensions",
    "--extension",
    CHILD_EXTENSION_PATH,
  ];

  for (const path of toolExtensionPaths) args.push("--extension", path);

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

function registerSubagentMessageTool(
  pi: ExtensionAPI,
  muxLayer: Layer.Layer<Mux>,
  runningSubagents: ReadonlyMap<string, RunningSubagent>,
): void {
  pi.registerTool({
    name: "subagent_message",
    label: "Message Subagent",
    description: "Send a steering message to a running subagent by its unique name.",
    parameters: SubagentMessageParameters,

    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

      const message = params.message.trim();

      if (!message) throw new Error("Subagent message must not be empty");

      const run = [...runningSubagents.values()].find(
        (candidate) => candidate.name === params.name && candidate.acceptingMessages,
      );

      if (!run) {
        const names: string[] = [];

        for (const candidate of runningSubagents.values()) {
          if (candidate.acceptingMessages) names.push(candidate.name);
        }

        throw new Error(
          `No running subagent named ${JSON.stringify(params.name)}. Available: ${names.join(", ") || "none"}`,
        );
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const mux = yield* Mux;
          yield* mux.sendInput(run.paneId, message);
        }).pipe(Effect.provide(muxLayer)),
      );

      return {
        content: [{ type: "text", text: `Sent message to ${JSON.stringify(run.name)}.` }],
        details: { runId: run.runId, paneId: run.paneId, name: run.name },
      };
    },
  });
}

function registerSubagentTool(
  pi: ExtensionAPI,
  muxLayer: Layer.Layer<Mux>,
  getDiscovery: (ctx: ExtensionContext) => Promise<ValidatedAgentDiscovery>,
  watchers: Set<AbortController>,
  reserveName: (requestedName: string) => string,
  releaseName: (name: string) => void,
  onRunStarted: (run: RunningSubagent, ctx: ExtensionContext) => void,
  onResultQueued: (runId: string, status: SubagentLiveStatus, ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn a specialist in a new split pane and return immediately with a run ID; this tool does not return the specialist's report.",
      "The complete final response is delivered later as a prioritized steer message, and the full conversation is archived for subagent_history recovery.",
      "After dispatching the needed parallel subagents, stop making nonessential tool calls and end the turn so prioritized completion messages can be delivered promptly. Never poll panes, temporary files, or subagent_history for completion status; results arrive automatically, and the user will report any missing delivery.",
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

      const allTools = pi.getAllTools();
      const availableTools = new Set(allTools.map((tool) => tool.name));
      const missingTools = agent.tools.filter((tool) => !availableTools.has(tool));

      if (missingTools.length > 0) {
        throw new Error(
          `Agent ${JSON.stringify(agent.name)} requests unavailable tools: ${missingTools.join(", ")}`,
        );
      }

      const toolExtensionPaths = extensionPathsForTools(agent.tools, allTools);
      const name = reserveName(params.name?.trim() || agent.name);
      let archive: Awaited<ReturnType<typeof createRunArchive>>;

      try {
        archive = await createRunArchive({
          parentSessionId: ctx.sessionManager.getSessionId(),
          name,
          agent: agent.name,
          task: params.task,
        });
      } catch (error) {
        releaseName(name);
        throw error;
      }

      const { runId, metadataPath, transcriptPath, resultPath, statusPath } = archive;
      const invocation = piInvocation(agentArguments(agent, name, params.task, toolExtensionPaths));
      let result: { paneId: string };

      try {
        result = await Effect.runPromise(
          Effect.gen(function* () {
            const mux = yield* Mux;

            return yield* mux.spawn({
              name,
              cwd: ctx.cwd,
              command: invocation.command,
              args: invocation.args,
              environment: {
                PI_SUBAGENT_RESULT_PATH: resultPath,
                PI_SUBAGENT_TRANSCRIPT_PATH: transcriptPath,
                PI_SUBAGENT_STATUS_PATH: statusPath,
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
        releaseName(name);
        throw error;
      }

      try {
        await updateRunMetadata(metadataPath, { status: "running", paneId: result.paneId });
        onRunStarted(
          {
            runId,
            paneId: result.paneId,
            name,
            agent: agent.name,
            startedAt: Date.now(),
            statusPath,
            status: {
              version: 1,
              state: "starting",
              stage: "launching",
              updatedAt: new Date().toISOString(),
            },
            acceptingMessages: true,
          },
          ctx,
        );
      } finally {
        releaseName(name);
      }

      const watcher = new AbortController();

      watchers.add(watcher);

      const resultPromise = Effect.runPromise(
        watchSubagentResult(resultPath, watcher.signal).pipe(Effect.provide(NodeFileSystem.layer)),
      );

      const exitPromise = Effect.runPromise(
        Effect.gen(function* () {
          const mux = yield* Mux;

          return yield* mux.waitForExit(result.paneId, watcher.signal);
        }).pipe(Effect.provide(muxLayer)),
      );

      void waitForSubagentResultOrExit(resultPromise, exitPromise)
        .then((childResult) => {
          const deliveryQueuedAt = new Date().toISOString();
          void updateRunMetadata(metadataPath, {
            status: childResult.isError ? "failed" : "finished",
            isError: childResult.isError,
            deliveryQueuedAt,
          }).catch(() => {});
          onResultQueued(
            runId,
            {
              version: 1,
              state: childResult.isError ? "failed" : "finished",
              stage: "result queued",
              updatedAt: deliveryQueuedAt,
            },
            ctx,
          );
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: [
                `Subagent ${JSON.stringify(name)} ${childResult.isError ? "failed" : "finished"} (run ${runId}):`,
                childResult.text,
                `Archived conversation: ${transcriptPath}`,
                `Use subagent_history with runId ${runId} to inspect or recover messages.`,
              ].join("\n\n"),
              display: true,
              details: {
                runId,
                paneId: result.paneId,
                agent: agent.name,
                name,
                isError: childResult.isError,
                transcriptPath,
                resultPath,
              },
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        })
        .catch(async (cause) => {
          if (watcher.signal.aborted) return;
          const message = errorMessage(cause);
          await updateRunMetadata(metadataPath, { status: "failed", error: message }).catch(
            () => {},
          );
          onResultQueued(
            runId,
            {
              version: 1,
              state: "failed",
              stage: "result queued",
              updatedAt: new Date().toISOString(),
            },
            ctx,
          );
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: [
                `Could not read the result from subagent ${JSON.stringify(name)} (run ${runId}): ${message}`,
                `Its archived conversation may still be available at ${transcriptPath}.`,
                `Use subagent_history with runId ${runId} to inspect it.`,
              ].join("\n\n"),
              display: true,
              details: {
                runId,
                paneId: result.paneId,
                agent: agent.name,
                name,
                isError: true,
                transcriptPath,
                resultPath,
              },
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        })
        .finally(() => {
          watcher.abort();
          watchers.delete(watcher);
        });

      return {
        content: [
          {
            type: "text",
            text: [
              `Spawned ${name} (${agent.name}) in ${result.paneId}.`,
              `Run ID: ${runId}`,
              "This is only a spawn receipt. The report will arrive asynchronously as a prioritized steer message.",
              "After dispatching the needed subagents, end the turn so results can arrive promptly. Do not poll the pane, transcript, or subagent_history for status.",
              `Recovery: subagent_history can inspect ${transcriptPath}`,
            ].join("\n"),
          },
        ],
        details: {
          runId,
          paneId: result.paneId,
          mux: "herdr",
          agent: agent.name,
          name,
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

  const discoveryWidgetId = "subagent-discovery";
  const runningWidgetId = "subagent-runs";
  let subagentRegistered = false;
  let discovery: ValidatedAgentDiscovery | undefined;
  let discoveryWidgetTimer: NodeJS.Timeout | undefined;
  let runningWidgetTimer: NodeJS.Timeout | undefined;
  let requestRunningWidgetRender: (() => void) | undefined;
  let statusRefreshInFlight = false;
  const watchers = new Set<AbortController>();
  const runningSubagents = new Map<string, RunningSubagent>();
  const reservedNames = new Set<string>();
  const deliveryTimers = new Map<string, NodeJS.Timeout>();

  const refreshRunningStatuses = async (): Promise<void> => {
    if (statusRefreshInFlight) return;
    statusRefreshInFlight = true;

    try {
      await Promise.all(
        [...runningSubagents.values()].map(async (run) => {
          if (!run.acceptingMessages) return;
          const status = await readSubagentStatus(run.statusPath);

          if (status) run.status = status;
        }),
      );
      requestRunningWidgetRender?.();
    } finally {
      statusRefreshInFlight = false;
    }
  };

  const showRunningWidget = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(runningWidgetId, (tui, theme) => {
      requestRunningWidgetRender = () => tui.requestRender();

      return new FramedWidget(
        (innerWidth) => {
          const runs = [...runningSubagents.values()].sort(
            (left, right) => left.startedAt - right.startedAt,
          );

          const active = runs.filter((run) => run.acceptingMessages).length;
          const queued = runs.length - active;

          return {
            title: "Subagents",
            rightTitle: queued > 0 ? `${active} running · ${queued} queued` : `${active} running`,
            lines: runs.map((run) => renderRunningSubagent(run, innerWidth, theme)),
          };
        },
        {
          border: (text) => theme.fg("borderAccent", text),
          title: (text) => theme.fg("accent", text),
          rightTitle: (text) => theme.fg("accent", text),
        },
      );
    });
  };

  const onRunStarted = (run: RunningSubagent, ctx: ExtensionContext): void => {
    runningSubagents.set(run.runId, run);

    if (runningSubagents.size === 1) showRunningWidget(ctx);

    if (!runningWidgetTimer) {
      runningWidgetTimer = setInterval(() => void refreshRunningStatuses(), 1_000);
      runningWidgetTimer.unref();
    }

    void refreshRunningStatuses();
  };

  const onRunFinished = (runId: string, ctx: ExtensionContext): void => {
    const timer = deliveryTimers.get(runId);

    if (timer) clearTimeout(timer);
    deliveryTimers.delete(runId);
    runningSubagents.delete(runId);

    if (runningSubagents.size > 0) {
      requestRunningWidgetRender?.();

      return;
    }

    if (runningWidgetTimer) clearInterval(runningWidgetTimer);
    runningWidgetTimer = undefined;
    requestRunningWidgetRender = undefined;
    ctx.ui.setWidget(runningWidgetId, undefined);
  };

  const reserveName = (requestedName: string): string => {
    const taken = new Set([...runningSubagents.values()].map((run) => run.name));

    for (const name of reservedNames) taken.add(name);

    const name = uniqueSubagentName(requestedName, taken);

    reservedNames.add(name);

    return name;
  };

  const releaseName = (name: string): void => {
    reservedNames.delete(name);
  };

  const onResultQueued = (
    runId: string,
    status: SubagentLiveStatus,
    ctx: ExtensionContext,
  ): void => {
    const run = runningSubagents.get(runId);

    if (!run) return;

    const existingTimer = deliveryTimers.get(runId);

    if (existingTimer) clearTimeout(existingTimer);

    run.acceptingMessages = false;
    run.status = status;
    requestRunningWidgetRender?.();

    const timer = setTimeout(() => onRunFinished(runId, ctx), 5 * 60_000);
    timer.unref();
    deliveryTimers.set(runId, timer);
  };

  pi.on("context", (event, ctx) => {
    for (const runId of deliveredSubagentRunIds(event.messages)) onRunFinished(runId, ctx);
  });

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
      registerSubagentTool(
        pi,
        muxLayer,
        getDiscovery,
        watchers,
        reserveName,
        releaseName,
        onRunStarted,
        onResultQueued,
      );
      registerSubagentMessageTool(pi, muxLayer, runningSubagents);
      subagentRegistered = true;
    }

    pi.setActiveTools([
      ...new Set([...pi.getActiveTools(), "subagent", "subagent_message", "subagent_history"]),
    ]);
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
    if (discoveryWidgetTimer) clearTimeout(discoveryWidgetTimer);
    ctx.ui.setWidget(discoveryWidgetId, reportLines(result));
    discoveryWidgetTimer = setTimeout(() => {
      ctx.ui.setWidget(discoveryWidgetId, undefined);
      discoveryWidgetTimer = undefined;
    }, 10_000);
    discoveryWidgetTimer.unref();
  };

  pi.on("session_shutdown", (_event, ctx) => {
    for (const watcher of watchers) watcher.abort();
    watchers.clear();

    if (discoveryWidgetTimer) clearTimeout(discoveryWidgetTimer);

    if (runningWidgetTimer) clearInterval(runningWidgetTimer);

    for (const timer of deliveryTimers.values()) clearTimeout(timer);
    deliveryTimers.clear();
    reservedNames.clear();
    discoveryWidgetTimer = undefined;
    runningWidgetTimer = undefined;
    requestRunningWidgetRender = undefined;
    runningSubagents.clear();
    ctx.ui.setWidget(discoveryWidgetId, undefined);
    ctx.ui.setWidget(runningWidgetId, undefined);
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
      "The subagent tool is asynchronous: its immediate result is only a spawn receipt. After dispatching the needed parallel subagents, stop making nonessential tool calls and end the turn so completed results can be delivered promptly. Never poll panes, temporary files, or subagent_history for completion status; results arrive automatically, and the user will report any missing delivery.",
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
              "Flow: subagent returns a spawn receipt immediately; end the turn after dispatch so its prioritized result can arrive promptly.",
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
