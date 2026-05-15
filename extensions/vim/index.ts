import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const quitCommands = new Set([":q", ":quit", ":q!", ":quit!"]);

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		const command = event.text.trim();
		if (!quitCommands.has(command)) return;

		ctx.shutdown();
		return { action: "handled" };
	});
}
