import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const logo = [
	"██████  ",
	"██  ██  ",
	"████  ██",
	"██    ██",
];

function center(line: string, width: number): string {
	const trimmedLine = line.trimEnd();
	const padding = Math.max(0, Math.floor((width - visibleWidth(trimmedLine)) / 2));
	return truncateToWidth(`${" ".repeat(padding)}${line}`, width);
}

function splashLines(theme: Theme, model: string): string[] {
	const blue = (text: string) => theme.fg("accent", text);
	const cyan = (text: string) => theme.fg("thinkingMedium", text);
	const dim = (text: string) => theme.fg("dim", text);
	const muted = (text: string) => theme.fg("muted", text);

	return [
		"",
		...logo.map((line) => blue(theme.bold(line))),
		"",
		`${cyan("pi")} ${dim(`v${VERSION}`)} ${muted("•")} ${muted(model)}`,
		"",
	];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return splashLines(theme, ctx.model?.id ?? "no-model").map((line) => center(line, width));
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
