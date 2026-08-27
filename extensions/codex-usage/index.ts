import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type UsageWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: string | number;
};

type UsageResponse = {
  account_id?: string;
  plan_type?: string;
  rate_limit?: {
    primary_window?: UsageWindow;
    secondary_window?: UsageWindow;
  };
  additional_rate_limits?: Array<{
    limit_name?: string;
    rate_limit?: {
      primary_window?: UsageWindow;
      secondary_window?: UsageWindow;
    };
  }>;
};

function formatNorwegianDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(milliseconds: number): string {
  let minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  minutes %= 24 * 60;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function formatWindow(label: string, window?: UsageWindow): string[] {
  if (!window) return [`${label}: unavailable`];

  const used = window.used_percent ?? 0;
  const remaining = Math.max(0, 100 - used);
  const resetDate =
    typeof window.reset_at === "number"
      ? new Date(window.reset_at * 1000)
      : window.reset_at
        ? new Date(window.reset_at)
        : undefined;
  const reset =
    resetDate && !Number.isNaN(resetDate.getTime())
      ? `${formatNorwegianDate(resetDate)} (${formatDuration(resetDate.getTime() - Date.now())})`
      : "unknown";

  const barWidth = 24;
  const filled = Math.round((remaining / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  return [
    label,
    `  [${bar}] ${remaining.toFixed(1)}% left`,
    `  Used:   ${used.toFixed(1)}%`,
    `  Resets: ${reset}`,
  ];
}

export async function resolveCodexAuth(ctx: Pick<ExtensionContext, "model" | "modelRegistry">) {
  const activeProvider = ctx.model?.provider;
  const providerNames = [
    activeProvider?.includes("codex") ? activeProvider : undefined,
    "openai-codex",
    "codex",
  ].filter(
    (provider, index, providers): provider is string =>
      Boolean(provider) && providers.indexOf(provider) === index,
  );

  for (const provider of providerNames) {
    try {
      const candidate = await ctx.modelRegistry.getProviderAuth(provider);
      if (candidate?.auth?.apiKey) return candidate;
    } catch {
      // Try the next Codex provider name.
    }
  }
  return undefined;
}

async function loadUsage(ctx: ExtensionContext): Promise<UsageResponse> {
  const auth = await resolveCodexAuth(ctx);
  if (!auth?.auth?.apiKey) {
    throw new Error("Pi did not expose a Codex OAuth token for the active provider.");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.auth.apiKey}`,
    "User-Agent": "pi-codex-usage",
    ...auth.auth.headers,
  };

  const accountId = headers["ChatGPT-Account-Id"] ?? headers["ChatGPT-Account-ID"];
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });

  if (!response.ok) {
    throw new Error(`Codex usage request failed: HTTP ${response.status}`);
  }

  return (await response.json()) as UsageResponse;
}

export default function (pi: ExtensionAPI) {
  let usageVisible = false;

  const hideUsage = (ctx: ExtensionContext): void => {
    usageVisible = false;
    ctx.ui.setWidget("codex-usage", undefined);
  };

  pi.on("input", (_event, ctx) => {
    if (usageVisible) hideUsage(ctx);
  });

  pi.registerCommand("usage", {
    description: "Toggle Codex session and weekly usage",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action && usageVisible) {
        hideUsage(ctx);
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("/usage requires a UI.", "error");
        return;
      }

      let lines: string[];
      try {
        const usage = await loadUsage(ctx);
        const extraLines = (usage.additional_rate_limits ?? []).flatMap((extra) => [
          "",
          ...formatWindow(
            extra.limit_name ?? "Additional limit",
            extra.rate_limit?.primary_window ?? extra.rate_limit?.secondary_window,
          ),
        ]);
        lines = [
          `Plan: ${usage.plan_type ?? "unknown"}`,
          usage.account_id ? `Account: ${usage.account_id}` : "",
          "",
          ...formatWindow("Session / 5 hours", usage.rate_limit?.primary_window),
          "",
          ...formatWindow("Weekly", usage.rate_limit?.secondary_window),
          ...extraLines,
        ];
      } catch (error) {
        lines = [
          "Could not load Codex usage.",
          "",
          error instanceof Error ? error.message : String(error),
        ];
      }

      usageVisible = true;
      ctx.ui.setWidget(
        "codex-usage",
        () => new Text(["Codex Usage", "", ...lines].join("\n"), 1, 0),
      );
    },
  });
}
