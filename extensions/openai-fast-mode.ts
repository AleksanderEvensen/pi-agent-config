import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SERVICE_TIER = "priority";
const CONFIG_PATH = join(getAgentDir(), "openai-fast-mode.json");

type OpenAIServiceTierPayload = Record<string, unknown> & {
  model: string;
  stream: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAIServiceTierPayload(payload: unknown): payload is OpenAIServiceTierPayload {
  if (!isRecord(payload)) return false;
  if (typeof payload.model !== "string") return false;
  if (payload.stream !== true) return false;

  return Array.isArray(payload.input) || Array.isArray(payload.messages);
}

function isNativeOpenAIModel(model: ExtensionContext["model"]): boolean {
  if (!model) return false;

  const isOpenAIProvider = model.provider === "openai" || model.provider === "openai-codex";
  const isOpenAIBaseUrl =
    model.baseUrl.includes("api.openai.com") || model.baseUrl.includes("chatgpt.com/backend-api");
  const isOpenAIAPI =
    model.api === "openai-responses" ||
    model.api === "openai-codex-responses" ||
    model.api === "openai-completions";

  return isOpenAIAPI && (isOpenAIProvider || isOpenAIBaseUrl);
}

function loadEnabled(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;

  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return isRecord(parsed) && parsed.enabled === true;
  } catch (error) {
    console.error(`[openai-fast-mode] Failed to read ${CONFIG_PATH}:`, error);
    return false;
  }
}

function saveEnabled(enabled: boolean): void {
  try {
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(`[openai-fast-mode] Failed to write ${CONFIG_PATH}:`, error);
  }
}

function parseToggleArg(args: string): "on" | "off" | "toggle" | "status" | undefined {
  const value = args.trim().toLowerCase();
  if (!value) return "toggle";
  if (["on", "enable", "enabled", "true", "1"].includes(value)) return "on";
  if (["off", "disable", "disabled", "false", "0"].includes(value)) return "off";
  if (["toggle", "switch"].includes(value)) return "toggle";
  if (["status", "show"].includes(value)) return "status";
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let enabled = loadEnabled();

  function updateStatus(ctx: ExtensionContext): void {
    const label = enabled
      ? ctx.ui.theme.fg("accent", "⚡ fast:on")
      : ctx.ui.theme.fg("dim", "⚡ fast:off");
    ctx.ui.setStatus("openai-fast-mode", label);
  }

  function setEnabled(ctx: ExtensionContext, nextEnabled: boolean): void {
    enabled = nextEnabled;
    saveEnabled(enabled);
    updateStatus(ctx);
  }

  pi.registerFlag("fast-mode", {
    description: "Enable OpenAI fast mode (service_tier=priority)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("fast-mode", {
    description: "Toggle OpenAI fast mode (priority service tier)",
    getArgumentCompletions: (prefix) => {
      const options = ["on", "off", "toggle", "status"];
      return options
        .filter((option) => option.startsWith(prefix.toLowerCase()))
        .map((option) => ({ value: option, label: option }));
    },
    handler: async (args, ctx) => {
      const action = parseToggleArg(args);
      if (!action) {
        ctx.ui.notify("Usage: /fast-mode [on|off|toggle|status]", "warning");
        return;
      }

      if (action === "status") {
        ctx.ui.notify(`OpenAI fast mode is ${enabled ? "enabled" : "disabled"}.`, "info");
        updateStatus(ctx);
        return;
      }

      const nextEnabled = action === "toggle" ? !enabled : action === "on";
      setEnabled(ctx, nextEnabled);

      const modelNote = isNativeOpenAIModel(ctx.model)
        ? ""
        : " Current model is not a native OpenAI model, so this will apply after switching to one.";
      ctx.ui.notify(
        `OpenAI fast mode ${enabled ? "enabled" : "disabled"}.${enabled ? modelNote : ""}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("fast-mode") === true) {
      enabled = true;
    }
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;
    if (!isNativeOpenAIModel(ctx.model)) return;
    if (!isOpenAIServiceTierPayload(event.payload)) return;

    return {
      ...event.payload,
      service_tier: SERVICE_TIER,
    };
  });
}
