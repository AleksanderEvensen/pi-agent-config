import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { errorMessage } from "../../lib/errors.ts";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const IMAGE_PLACEHOLDER = "[image omitted]";

function callout(type: string, title: string, bodyLines: string[] = []): string {
  const lines = [`> [!${type}] ${title}`, ...bodyLines.map((line) => `> ${line}`)];

  return lines.join("\n");
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (!Array.isArray(content)) return content;

  return content.map((part) => (part.type === "text" ? part.text : IMAGE_PLACEHOLDER)).join("\n");
}

export function formatUserMessage(message: Pick<UserMessage, "content">): string {
  return callout("quote", "User", contentText(message.content).split("\n"));
}

export function formatAssistantMessage(message: Pick<AssistantMessage, "content">): string {
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

  return text ? callout("abstract", "Pi Agent", text.split("\n")) : "";
}

async function prepareFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  try {
    await access(path);
    const info = await stat(path);

    if (!info.isFile()) throw new Error("path is not a file");

    if (info.size > 0) await writeFile(path, "\n\n---\n\n", { flag: "a" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await writeFile(path, "");

      return;
    }

    throw error;
  }
}

function resolveCapturePath(cwd: string, rawPath: string): string {
  if (rawPath === "~") return homedir();

  if (rawPath.startsWith("~/")) return resolve(homedir(), rawPath.slice(2));

  return resolve(cwd, rawPath);
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
  ): Promise<void> => {
    const path = activePath;

    if (!path || !text) return;

    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => writeFile(path, `${text}\n`, { flag: "a" }));

    try {
      await writeQueue;
    } catch (error) {
      disable();
      ctx.ui.notify(`Could not write Markdown: ${errorMessage(error)}`, "error");
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

      const path = resolveCapturePath(ctx.cwd, rawPath);

      try {
        await prepareFile(path);
        activePath = path;
        ctx.ui.notify(`Markdown capture linked to: ${path}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not link Markdown file: ${errorMessage(error)}`, "error");
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

      disable();
      ctx.ui.notify("Markdown capture disabled", "info");
    },
  });

  pi.on("message_end", async (event, ctx) => {
    if (!activePath) return;

    const message = event.message;

    if (message.role === "user") {
      await append(formatUserMessage(message), ctx);
    } else if (message.role === "assistant") {
      await append(formatAssistantMessage(message), ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    disable();
    await writeQueue.catch(() => undefined);
  });
}
