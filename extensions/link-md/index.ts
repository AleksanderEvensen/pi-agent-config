import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const IMAGE_PLACEHOLDER = "[image omitted]";

function quoteCallout(label: string, body: string): string {
  const lines = body.split("\n");
  return [`> [!${label}]`, ...lines.map((line) => `> ${line}`), ""].join("\n");
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : IMAGE_PLACEHOLDER))
    .join("\n");
}

export function formatUserMessage(message: Pick<UserMessage, "content">): string {
  return quoteCallout("USER", contentText(message.content));
}

export function formatAssistantMessage(message: Pick<AssistantMessage, "content">): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function prepareFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await access(path);
    if ((await stat(path)).size > 0) await writeFile(path, "\n\n---\n\n", { flag: "a" });
  } catch {
    await writeFile(path, "", { flag: "a" });
  }
}

export default function linkMarkdown(pi: ExtensionAPI): void {
  let activePath: string | undefined;
  let writeQueue = Promise.resolve();

  const disable = () => {
    activePath = undefined;
  };

  const append = async (
    text: string,
    ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): void } },
    separator = false,
  ): Promise<void> => {
    const path = activePath;
    if (!path || !text) return;

    writeQueue = writeQueue.then(() =>
      writeFile(path, `${text}${separator ? "\n\n---\n\n" : "\n"}`, { flag: "a" }),
    );
    try {
      await writeQueue;
    } catch (error) {
      disable();
      ctx.ui.notify(`Could not write Markdown: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.registerCommand("link-md", {
    description: "Capture future conversation messages in a Markdown file",
    handler: async (args, ctx) => {
      const rawPath = args.trim();
      if (!rawPath) {
        ctx.ui.notify("Usage: /link-md <file-path>", "warning");
        return;
      }

      const path = resolve(ctx.cwd, rawPath);
      try {
        await prepareFile(path);
        activePath = path;
        ctx.ui.notify(`Markdown capture linked to ${path}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not link Markdown file: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("unlink-md", {
    description: "Stop capturing conversation to Markdown",
    handler: async (_args, ctx) => {
      if (!activePath) {
        ctx.ui.notify("Markdown capture is already off", "info");
        return;
      }
      activePath = undefined;
      ctx.ui.notify("Markdown capture disabled", "info");
    },
  });

  pi.on("message_end", async (event, ctx) => {
    if (!activePath) return;
    const message = event.message;

    if (message.role === "user") {
      await append(formatUserMessage(message), ctx);
      return;
    }

    if (message.role === "assistant") {
      const text = formatAssistantMessage(message);
      if (text) await append(text, ctx);
    }
  });

  pi.on("session_shutdown", () => {
    activePath = undefined;
  });
}
