import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// oxfmt-ignore
const piLogo = [
	"██████  ",
	"██  ██  ",
	"████  ██",
	"██    ██"
];

// Tau is the ephemeral counterpart to pi: 2π, but with no saved session.
const tauLogo = ["████████", "   ██   ", "   ██   ", "   ████ "];

function center(line: string, width: number): string {
  const trimmedLine = line.trimEnd();
  const padding = Math.max(0, Math.floor((width - visibleWidth(trimmedLine)) / 2));

  return truncateToWidth(`${" ".repeat(padding)}${line}`, width);
}

function splashLines(theme: Theme, model: string, ephemeral: boolean): string[] {
  const logo = ephemeral ? tauLogo : piLogo;
  const logoColor = (text: string) => theme.fg(ephemeral ? "warning" : "accent", text);
  const cyan = (text: string) => theme.fg("thinkingMedium", text);
  const dim = (text: string) => theme.fg("dim", text);
  const muted = (text: string) => theme.fg("muted", text);

  return [
    "",
    ...logo.map((line) => logoColor(theme.bold(line))),
    "",
    `${cyan(ephemeral ? "τ" : "pi")} ${dim(`v${VERSION}`)} ${muted("•")} ${muted(model)}${ephemeral ? ` ${muted("•")} ${theme.fg("warning", "no session")}` : ""}`,
    "",
  ];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return splashLines(
          theme,
          ctx.model?.id ?? "no-model",
          ctx.sessionManager.getSessionFile() === undefined,
        ).map((line) => center(line, width));
      },
    }));
  });

  pi.registerCommand("builtin-header", {
    description: "Restore the built-in Pi header",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
