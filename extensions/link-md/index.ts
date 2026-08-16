import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ASK_USER = "ask_user";
const IMAGE_PLACEHOLDER = "[image omitted]";

type AskQuestion = {
  label: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
};

type AskAnswer = {
  label: string;
  choices: Array<{ label: string }>;
};

type AskUserResult = {
  cancelled?: boolean;
  answers?: AskAnswer[];
};

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

function askQuestions(toolCall: ToolCall): AskQuestion[] {
  const args = toolCall.arguments;
  if (!Array.isArray(args.questions)) return [];

  return args.questions.flatMap((value, index): AskQuestion[] => {
    if (!value || typeof value !== "object") return [];
    const question = value as {
      label?: unknown;
      question?: unknown;
      options?: unknown;
    };
    if (typeof question.question !== "string" || !Array.isArray(question.options)) return [];

    const options = question.options.flatMap((option): AskQuestion["options"] => {
      if (!option || typeof option !== "object") return [];
      const item = option as { label?: unknown; description?: unknown };
      if (typeof item.label !== "string") return [];
      return [
        {
          label: item.label,
          ...(typeof item.description === "string" ? { description: item.description } : {}),
        },
      ];
    });

    return [
      {
        label: typeof question.label === "string" ? question.label : `Q${index + 1}`,
        question: question.question,
        options,
      },
    ];
  });
}

function formatQuestions(questions: AskQuestion[]): string {
  const body = questions
    .map((question) => {
      const options = question.options
        .map((option) => `- ${option.label}${option.description ? ` — ${option.description}` : ""}`)
        .join("\n");
      return `**${question.label}:** ${question.question}${options ? `\n${options}` : ""}`;
    })
    .join("\n\n");
  return quoteCallout("QUESTION", body);
}

function readAskResult(message: ToolResultMessage): AskUserResult {
  const details: unknown = message.details;
  if (!details || typeof details !== "object") return {};
  const value = details as { cancelled?: unknown; answers?: unknown };
  if (!Array.isArray(value.answers)) return { cancelled: value.cancelled === true };

  const answers = value.answers.flatMap((answer): AskAnswer[] => {
    if (!answer || typeof answer !== "object") return [];
    const value = answer as { label?: unknown; choices?: unknown };
    if (typeof value.label !== "string" || !Array.isArray(value.choices)) return [];
    const choices = value.choices.flatMap((choice): Array<{ label: string }> => {
      if (!choice || typeof choice !== "object") return [];
      const item = choice as { label?: unknown };
      return typeof item.label === "string" ? [{ label: item.label }] : [];
    });
    return [{ label: value.label, choices }];
  });

  return { cancelled: value.cancelled === true, answers };
}

function formatAnswers(result: AskUserResult): string {
  if (result.cancelled) return quoteCallout("ANSWER", "Cancelled");
  const body = (result.answers ?? [])
    .map((answer) => `**${answer.label}:** ${answer.choices.map((choice) => choice.label).join(", ")}`)
    .join("\n");
  return quoteCallout("ANSWER", body || "(no answer)");
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
  const pendingQuestions = new Map<string, string>();

  const disable = () => {
    activePath = undefined;
    pendingQuestions.clear();
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
        pendingQuestions.clear();
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
      pendingQuestions.clear();
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
      const hasAskUserCall = message.content.some(
        (part) => part.type === "toolCall" && part.name === ASK_USER,
      );
      if (text) await append(text, ctx, !hasAskUserCall);

      for (const part of message.content) {
        if (part.type !== "toolCall" || part.name !== ASK_USER) continue;
        const questions = askQuestions(part);
        if (questions.length === 0) continue;
        const formattedQuestions = formatQuestions(questions);
        pendingQuestions.set(part.id, formattedQuestions);
        await append(formattedQuestions, ctx);
      }
      return;
    }

    if (message.role === "toolResult" && message.toolName === ASK_USER) {
      const question = pendingQuestions.get(message.toolCallId);
      pendingQuestions.delete(message.toolCallId);
      if (question) await append(formatAnswers(readAskResult(message)), ctx);
    }
  });

  pi.on("session_shutdown", () => {
    activePath = undefined;
    pendingQuestions.clear();
  });
}
