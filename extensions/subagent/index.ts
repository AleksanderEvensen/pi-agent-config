import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { discoverAgents } from "./agents.ts";
import { progressText, snapshotOf, startAgent, steerAgent, waitForAgent } from "./process.ts";
import { actionSchema, type Action, type AgentUpdate, type RunningAgent } from "./types.ts";

type WidgetSetter = (
  key: string,
  lines: string[] | undefined,
  options?: { placement: "aboveEditor" | "belowEditor" },
) => void;

const WIDGET_KEY = "subagent-agents";
const MAX_ACTIVE_CHILDREN = 8;

type ValidAction =
  | { action: "spawn"; agent: string; task: string; cwd?: string }
  | { action: "wait"; id: string }
  | { action: "steer"; id: string; message: string };

function valuesOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(values: Record<string, unknown>, field: string): string {
  const value = values[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`subagent ${field} must be a non-empty string`);
  }
  return value;
}

export function validateAction(value: unknown): ValidAction {
  const values = valuesOf(value);
  if (!values || typeof values.action !== "string") {
    throw new Error("subagent action must be one of spawn, wait, or steer");
  }

  switch (values.action) {
    case "spawn": {
      const cwd = typeof values.cwd === "string" ? values.cwd.replace(/^@/, "") : values.cwd;
      if (cwd !== undefined && (typeof cwd !== "string" || !cwd.trim())) {
        throw new Error("subagent cwd must be a non-empty string when provided");
      }
      return {
        action: "spawn",
        agent: requiredString(values, "agent"),
        task: requiredString(values, "task"),
        ...(cwd === undefined ? {} : { cwd }),
      };
    }
    case "wait":
      return { action: "wait", id: requiredString(values, "id") };
    case "steer":
      return {
        action: "steer",
        id: requiredString(values, "id"),
        message: requiredString(values, "message"),
      };
    default:
      throw new Error(`subagent action '${values.action}' is not supported`);
  }
}

function agentId(name: string, number: number): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent";
  return `${slug}-${number}`;
}

export default function subagent(pi: ExtensionAPI): void {
  const allowlist = process.env.PI_SUBAGENT_ALLOWED?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const permitted = (agentName: string) => !allowlist || allowlist.includes(agentName);
  const userAgents = discoverAgents(process.cwd(), { includeProject: false }).filter((agent) =>
    permitted(agent.name),
  );
  const running = new Map<string, RunningAgent>();
  let widgetSetter: WidgetSetter | undefined;
  let nextId = 1;
  let shuttingDown = false;

  const refreshWidget = (): void => {
    if (!widgetSetter) return;
    const active = [...running.values()].filter((agent) => agent.status === "running");
    if (active.length === 0) {
      widgetSetter(WIDGET_KEY, undefined);
      return;
    }

    const lines = active.flatMap((agent) => {
      const snapshot = snapshotOf(agent);
      const stats = `${snapshot.status} · ${snapshot.toolCount} tools · ${Math.floor(snapshot.durationMs / 1000)}s · ↑${snapshot.usage.input} ↓${snapshot.usage.output}`;
      const indent = (line: string): string =>
        line
          .split("\n")
          .map((part) => `  ${part}`)
          .join("\n");
      return [
        `${snapshot.id} · ${snapshot.agent} · ${stats}`,
        ...snapshot.transcript.slice(-2).map(indent),
        ...(snapshot.lastMessage ? [indent(snapshot.lastMessage)] : []),
      ];
    });
    widgetSetter(WIDGET_KEY, lines, { placement: "belowEditor" });
  };
  const widgetUpdate: AgentUpdate = () => refreshWidget();
  const terminateChild = (child: RunningAgent): void => {
    if (child.status !== "running") return;
    try {
      child.process.kill("SIGTERM");
    } catch {
      // The child may have exited between the status check and kill.
    }
    const forceKillTimer = setTimeout(() => {
      if (child.status === "running") {
        try {
          child.process.kill("SIGKILL");
        } catch {
          // The child may have exited before the fallback signal.
        }
      }
    }, 1_000);
    forceKillTimer.unref?.();
    child.done.then(
      () => clearTimeout(forceKillTimer),
      () => clearTimeout(forceKillTimer),
    );
  };
  const queueReattachment = (child: RunningAgent): void => {
    if (
      shuttingDown ||
      child.collected ||
      child.waiting ||
      child.status === "running" ||
      child.notified ||
      child.reattachmentQueued
    )
      return;
    child.reattachmentQueued = true;
    try {
      const result =
        child.status === "failed"
          ? `SUBAGENT_FAILED: ${child.error ?? "Subagent failed"}`
          : `Result:\n${child.output ?? "(no output)"}`;
      pi.sendMessage(
        {
          customType: "subagent-reattachment",
          content: `Subagent ${child.id} completed with status ${child.status}.\n\n${result}\n\nCall the subagent tool with action "wait" and id "${child.id}" only if you need to collect its details.`,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      child.notified = true;
    } catch {
      child.reattachmentQueued = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    widgetSetter = (key, lines, options) => ctx.ui.setWidget(key, lines, options);
    refreshWidget();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Use subagents only when the user explicitly asks for delegation or parallel work. Assign non-overlapping scopes and track them. Actions: spawn requires agent and task, with optional cwd; wait requires id; steer requires id and message. A child can delegate only when its definition grants a restricted agent allowlist. Each child reports a short tool-call transcript. User agents available at load time: ${userAgents.map((agent) => `${agent.name}${agent.description ? ` — ${agent.description}` : ""}`).join("; ") || "none"}. Trusted project agents are discovered only when spawning. Use the exact id returned by spawn (for example, scout-1) when waiting or steering. If the user sends a message while wait is active, wait returns early without cancelling the child so you can act on the message and steer it.`,
    promptSnippet: "Delegate only when the user explicitly requests subagents",
    promptGuidelines: [
      "Do not use this tool unless the user explicitly asks you to use subagents, delegate, or parallelize work.",
      "Assign disjoint scopes and include each child's exclusive scope in its task; do not send overlapping tasks.",
      "Track assignments and reconcile child results before reporting.",
    ],
    parameters: actionSchema,
    async execute(_toolCallId, params: Action, signal, onUpdate, ctx) {
      const action = validateAction(params);
      if (action.action === "spawn") {
        const activeCount = [...running.values()].filter(
          (child) => child.status === "running",
        ).length;
        if (activeCount >= MAX_ACTIVE_CHILDREN) {
          throw new Error(`Active subagent limit reached (${MAX_ACTIVE_CHILDREN})`);
        }
        const agents = discoverAgents(ctx.cwd, {
          includeProject: ctx.isProjectTrusted(),
        }).filter((agent) => permitted(agent.name));
        const agent = agents.find((candidate) => candidate.name === action.agent);
        if (!agent) {
          throw new Error(
            `Unknown agent '${action.agent}'. Available: ${agents.map((item) => item.name).join(", ") || "none"}`,
          );
        }

        const id = agentId(agent.name, nextId++);
        const child = startAgent(
          agent,
          action.task,
          action.cwd ? resolve(ctx.cwd, action.cwd) : ctx.cwd,
          id,
        );
        running.set(id, child);
        child.listeners.add(widgetUpdate);
        child.done.then(
          () => queueReattachment(child),
          () => queueReattachment(child),
        );
        refreshWidget();
        const snapshot = snapshotOf(child);
        return {
          content: [
            {
              type: "text",
              text: `Spawned ${id}. Use action: "wait" with id "${id}".\n\n${progressText(snapshot)}`,
            },
          ],
          details: snapshot,
        };
      }

      const child = running.get(action.id);
      if (!child) throw new Error(`Unknown agent id: ${action.id}`);

      if (action.action === "steer") {
        if (child.status !== "running") {
          throw new Error(`Agent ${action.id} is already ${child.status}`);
        }
        steerAgent(child, action.message);
        const snapshot = snapshotOf(child);
        return {
          content: [
            {
              type: "text",
              text: `Steering message sent to ${action.id}.\n\n${progressText(snapshot)}`,
            },
          ],
          details: snapshot,
        };
      }

      if (child.waiting) {
        throw new Error(`Agent ${action.id} already has a wait in progress`);
      }

      if (child.notified) {
        child.collected = true;
        const snapshot = snapshotOf(child);
        return {
          content: [
            {
              type: "text",
              text: `${progressText(snapshot)}\n\nThis result was already reported automatically; no duplicate result is returned.`,
            },
          ],
          details: snapshot,
        };
      }

      child.waiting = true;
      const update: AgentUpdate = (snapshot) => {
        onUpdate?.({
          content: [{ type: "text", text: progressText(snapshot) }],
          details: snapshot,
        });
      };
      child.listeners.add(update);
      update(snapshotOf(child));
      try {
        const outcome = await waitForAgent(child, signal, () => ctx.hasPendingMessages());
        const snapshot = snapshotOf(child);
        if (outcome.kind === "released") {
          child.waiting = false;
          if (outcome.reason === "pending_message") queueReattachment(child);
          return {
            content: [
              {
                type: "text",
                text:
                  outcome.reason === "pending_message"
                    ? `${progressText(snapshot)}\n\nWait released because a user message is pending. ${child.status === "running" ? `Agent ${child.id} continues running; it will be reattached automatically when it settles.` : `Agent ${child.id} is already ${child.status}; its result will be reattached automatically.`}`
                    : `${progressText(snapshot)}\n\nWait released because it was cancelled.`,
              },
            ],
            details: snapshot,
          };
        }
        if (outcome.kind === "failed") {
          child.collected = true;
          const message =
            outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          return {
            content: [
              { type: "text", text: `${progressText(snapshot)}\n\nSUBAGENT_FAILED: ${message}` },
            ],
            details: snapshot,
          };
        }
        child.collected = true;
        return {
          content: [
            { type: "text", text: `${progressText(snapshot)}\n\nResult:\n${outcome.output}` },
          ],
          details: snapshot,
        };
      } finally {
        child.waiting = false;
        child.listeners.delete(update);
        if (!child.collected) queueReattachment(child);
      }
    },
    renderCall(args, theme, context) {
      const action = typeof args.action === "string" ? args.action : "subagent";
      const agent =
        args.action === "spawn" && typeof args.agent === "string" ? ` ${args.agent}` : "";
      const task = args.action === "spawn" && typeof args.task === "string" ? args.task : "";
      const label = `${theme.fg("toolTitle", theme.bold(action))}${theme.fg("accent", agent)}`;
      if (!context.expanded) {
        const preview = task.replace(/\s+/g, " ");
        return new Text(
          `${label}${preview ? ` ${theme.fg("dim", preview.slice(0, 80))}` : ""}`,
          0,
          0,
        );
      }
      const container = new Container();
      container.addChild(new Text(label, 0, 0));
      if (task) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(task, 0, 0));
      }
      return container;
    },
    renderResult(result, options, theme) {
      const details = result.details as import("./types.ts").AgentSnapshot | undefined;
      if (!details || typeof details !== "object" || !("id" in details)) {
        return new Text(
          result.content[0]?.type === "text" ? result.content[0].text : "(no output)",
          0,
          0,
        );
      }
      const color =
        details.status === "failed"
          ? "error"
          : details.status === "completed"
            ? "success"
            : "warning";
      const container = new Container();
      container.addChild(
        new Text(
          theme.fg(
            color,
            `${details.status === "completed" ? "✓" : details.status === "failed" ? "✗" : "⟳"} ${details.id} · ${details.agent} · ${details.toolCount} tools · ${Math.floor(details.durationMs / 1000)}s · ↑${details.usage.input} ↓${details.usage.output}`,
          ),
          0,
          0,
        ),
      );
      for (const line of details.transcript)
        container.addChild(new Text(theme.fg("muted", line), 0, 0));
      if (details.lastMessage) container.addChild(new Text(details.lastMessage, 0, 0));
      if (options.expanded && details.output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(details.output, 0, 0, getMarkdownTheme()));
      }
      if (details.error)
        container.addChild(new Text(theme.fg("error", `Error: ${details.error}`), 0, 0));
      return container;
    },
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    widgetSetter?.(WIDGET_KEY, undefined);
    widgetSetter = undefined;
    for (const child of running.values()) {
      child.listeners.clear();
      terminateChild(child);
    }
    await Promise.all([...running.values()].map((child) => child.done.catch(() => "")));
  });
}
