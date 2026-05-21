import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { dim, hex, rgb } from "ansis";
import os from "node:os";

const orange = hex("#ff9e00");
const blue = hex("#6cb6ff");

function displayCwd(cwd: string): string {
  const home = os.homedir();

  if (cwd === home) return "~/";
  if (cwd.startsWith(`${home}`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function shortNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function contextColor(percent: number | null) {
  if (percent === null) return rgb(140, 140, 140);

  // 0% -> green, 50% -> yellow, 100% -> red.
  const t = Math.max(0, Math.min(1, percent / 100));
  const red = t < 0.5 ? Math.round(80 + t * 2 * 175) : 255;
  const green = t < 0.5 ? 220 : Math.round(220 - (t - 0.5) * 2 * 160);
  const blue = 80;
  return rgb(red, green, blue);
}

function contextText(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const tokens = usage?.tokens ?? null;
  const percent =
    usage?.percent ??
    (tokens !== null && contextWindow > 0 ? (tokens / contextWindow) * 100 : null);

  const percentText = percent === null ? "?%" : `${Math.round(percent)}%`;
  const usedText = tokens === null ? "?" : shortNumber(tokens);
  const totalText = contextWindow > 0 ? shortNumber(contextWindow) : "?";

  return contextColor(percent)`Context: ${percentText} ${usedText}/${totalText}`;
}

function tokenStats(ctx: ExtensionContext): { input: number; output: number; cached: number } {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (entry.message as AssistantMessage).usage;
    input += usage?.input ?? 0;
    output += usage?.output ?? 0;
    cacheRead += usage?.cacheRead ?? 0;
    cacheWrite += usage?.cacheWrite ?? 0;
  }

  return { input, output, cached: cacheRead + cacheWrite };
}

function ioText(ctx: ExtensionContext): string {
  const { input, output } = tokenStats(ctx);
  return blue`${shortNumber(input)}↓/${shortNumber(output)}↑`;
}

function cachedText(ctx: ExtensionContext): string {
  const { cached } = tokenStats(ctx);
  return blue`Cached: ${shortNumber(cached)}`;
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext) {
  ctx.ui.setFooter((tui, _theme, footerData) => {
    const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubBranch,
      invalidate() {},
      render(width: number): string[] {
        const branch = footerData.getGitBranch();
        const model = ctx.model?.id ?? "no-model";
        const effort = pi.getThinkingLevel?.() ?? "off";

        const extensionStatuses = [...footerData.getExtensionStatuses().values()];
        const parts = [
          dim(displayCwd(ctx.cwd)),
          branch ? orange(branch) : undefined,
          model,
          `[${effort}]`,
          ...extensionStatuses,
          contextText(ctx),
          cachedText(ctx),
          ioText(ctx),
        ].filter(Boolean) as string[];

        return [truncateToWidth(`  ${parts.join(" ")}`, width)];
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => installFooter(pi, ctx));
  pi.on("model_select", async (_event, ctx) => installFooter(pi, ctx));
  pi.on("thinking_level_select", async (_event, ctx) => installFooter(pi, ctx));
  pi.on("message_end", async (_event, ctx) => installFooter(pi, ctx));
}
