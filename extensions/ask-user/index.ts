import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "ask_user";
const CUSTOM_LABEL = "Write your own answer…";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Concise option label" }),
  description: Type.Optional(Type.String({ description: "Concise tradeoff or recommendation" })),
});

const QuestionSchema = Type.Object({
  label: Type.Optional(
    Type.String({ description: "Short batch tab label; defaults to Q1, Q2, etc." }),
  ),
  question: Type.String({ description: "Short question shown to the user" }),
  mode: Type.Optional(
    StringEnum(["single", "multiple"] as const, {
      description: "Whether the user selects one or multiple answers; defaults to single",
    }),
  ),
  options: Type.Array(OptionSchema, {
    minItems: 1,
    maxItems: 6,
    description: "Concrete answers. A custom-answer option is always appended by the extension.",
  }),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 5,
    description: "One question, or a batch of independent questions",
  }),
});

type Question = {
  label: string;
  question: string;
  mode: "single" | "multiple";
  options: Array<{ label: string; description?: string }>;
};

type AnswerState = {
  selected: Set<number>;
  custom?: string;
};

type AnswerChoice = {
  label: string;
  custom: boolean;
  option?: number;
};

type Answer = {
  question: number;
  label: string;
  choices: AnswerChoice[];
};

type AskUserDetails = {
  cancelled: boolean;
  answers: Answer[];
};

export function isAnswered(answer: Pick<AnswerState, "selected" | "custom"> | undefined): boolean {
  return Boolean(answer && (answer.selected.size > 0 || answer.custom?.trim()));
}

function isTuiContext(ctx: { hasUI: boolean }): boolean {
  return "mode" in ctx ? ctx.mode === "tui" : ctx.hasUI;
}

function answerChoices(question: Question, answer: AnswerState): AnswerChoice[] {
  const choices: AnswerChoice[] = [...answer.selected]
    .sort((a, b) => a - b)
    .map((index) => ({ label: question.options[index]!.label, custom: false, option: index + 1 }));
  if (answer.custom) choices.push({ label: answer.custom, custom: true });
  return choices;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask User",
    description:
      "Ask one short question or a batch of up to five independent questions. Each question has 1-6 concrete choices, supports single or multiple selection, and always lets the user write a custom answer. Do not use for free-text-only questions.",
    promptSnippet: "Ask short single-select or multi-select clarification questions",
    promptGuidelines: [
      "Use ask_user only for short clarification questions with concrete choices; do not use ask_user when only a free-text answer is expected.",
      "Batch ask_user questions only when they are independent; ask dependent questions in separate calls.",
      "Keep ask_user option labels and descriptions concise, and identify the recommended choice in its description when useful.",
    ],
    parameters: AskUserParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isTuiContext(ctx)) throw new Error("ask_user requires interactive TUI mode");

      const questions: Question[] = params.questions.map((question, index) => ({
        ...question,
        label: question.label?.trim() || `Q${index + 1}`,
        mode: question.mode ?? "single",
      }));
      const isBatch = questions.length > 1;

      const result = await ctx.ui.custom<AskUserDetails>((tui, theme, keybindings, done) => {
        const answers = new Map<number, AnswerState>();
        const cursors = questions.map(() => 0);
        let currentTab = 0;
        let editingQuestion: number | undefined;
        let editorError = false;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;
        let focused = false;

        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("accent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        };
        const editor = new Editor(tui, editorTheme);

        const refresh = () => {
          cachedWidth = undefined;
          cachedLines = undefined;
          tui.requestRender();
        };

        const getAnswer = (questionIndex: number) => {
          let answer = answers.get(questionIndex);
          if (!answer) {
            answer = { selected: new Set() };
            answers.set(questionIndex, answer);
          }
          return answer;
        };

        const allAnswered = () => questions.every((_, index) => isAnswered(answers.get(index)));

        const finish = (cancelled: boolean) => {
          done({
            cancelled,
            answers: cancelled
              ? []
              : questions.map((question, index) => ({
                  question: index + 1,
                  label: question.label,
                  choices: answerChoices(question, answers.get(index)!),
                })),
          });
        };

        const advance = () => {
          if (!isBatch) {
            finish(false);
            return;
          }
          currentTab = allAnswered()
            ? questions.length
            : Math.min(currentTab + 1, questions.length - 1);
          refresh();
        };

        const openEditor = (questionIndex: number) => {
          editingQuestion = questionIndex;
          editorError = false;
          editor.setText(answers.get(questionIndex)?.custom ?? "");
          editor.focused = focused;
          refresh();
        };

        const closeEditor = () => {
          editingQuestion = undefined;
          editorError = false;
          editor.focused = false;
          refresh();
        };

        editor.onSubmit = (value) => {
          if (editingQuestion === undefined) return;
          const trimmed = value.trim();
          if (!trimmed) {
            editorError = true;
            editor.setText(answers.get(editingQuestion)?.custom ?? "");
            refresh();
            return;
          }

          const questionIndex = editingQuestion;
          const answer = getAnswer(questionIndex);
          answer.custom = trimmed;
          if (questions[questionIndex]!.mode === "single") answer.selected.clear();
          closeEditor();
          if (questions[questionIndex]!.mode === "single") advance();
        };

        const selectSingle = (questionIndex: number, optionIndex: number) => {
          const answer = getAnswer(questionIndex);
          answer.selected = new Set([optionIndex]);
          answer.custom = undefined;
          advance();
        };

        const toggleMultiple = (questionIndex: number, optionIndex: number) => {
          const answer = getAnswer(questionIndex);
          if (answer.selected.has(optionIndex)) answer.selected.delete(optionIndex);
          else answer.selected.add(optionIndex);
          refresh();
        };

        const handleInput = (data: string) => {
          if (editingQuestion !== undefined) {
            if (matchesKey(data, Key.escape)) {
              closeEditor();
              return;
            }
            editorError = false;
            editor.handleInput(data);
            refresh();
            return;
          }

          if (matchesKey(data, Key.escape)) {
            finish(true);
            return;
          }

          if (isBatch && matchesKey(data, Key.left)) {
            currentTab = Math.max(0, currentTab - 1);
            refresh();
            return;
          }
          if (isBatch && matchesKey(data, Key.right)) {
            const lastTab = allAnswered() ? questions.length : questions.length - 1;
            currentTab = Math.min(lastTab, currentTab + 1);
            refresh();
            return;
          }

          if (currentTab === questions.length) {
            if (keybindings.matches(data, "tui.select.confirm")) finish(false);
            return;
          }

          const question = questions[currentTab]!;
          const customIndex = question.options.length;
          const doneIndex = customIndex + 1;
          const lastIndex = question.mode === "multiple" ? doneIndex : customIndex;

          if (keybindings.matches(data, "tui.select.up")) {
            cursors[currentTab] = Math.max(0, cursors[currentTab]! - 1);
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.down")) {
            cursors[currentTab] = Math.min(lastIndex, cursors[currentTab]! + 1);
            refresh();
            return;
          }

          const cursor = cursors[currentTab]!;
          const toggle = question.mode === "multiple" && matchesKey(data, Key.space);
          const confirm = keybindings.matches(data, "tui.select.confirm");
          if (!toggle && !confirm) return;

          if (cursor < customIndex) {
            if (question.mode === "single" && confirm) selectSingle(currentTab, cursor);
            else if (toggle) toggleMultiple(currentTab, cursor);
            return;
          }
          if (cursor === customIndex) {
            if (confirm) openEditor(currentTab);
            return;
          }
          if (confirm && isAnswered(answers.get(currentTab))) advance();
        };

        const render = (width: number): string[] => {
          if (cachedLines && cachedWidth === width) return cachedLines;

          const renderWidth = Math.max(1, width);
          const lines: string[] = [];
          const addWrapped = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth));
          const addPrefixed = (prefix: string, text: string) => {
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= renderWidth) {
              addWrapped(prefix + text);
              return;
            }
            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
            const continuation = " ".repeat(prefixWidth);
            wrapped.forEach((line, index) =>
              lines.push(`${index === 0 ? prefix : continuation}${line}`),
            );
          };

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

          if (isBatch) {
            const tabs = questions.map((question, index) => {
              const answered = isAnswered(answers.get(index));
              const text = ` ${answered ? "●" : "○"} ${question.label} `;
              if (currentTab === index) return theme.bg("selectedBg", theme.fg("text", text));
              return theme.fg(answered ? "success" : "muted", text);
            });
            const reviewText = " ✓ Review ";
            tabs.push(
              currentTab === questions.length
                ? theme.bg("selectedBg", theme.fg("text", reviewText))
                : theme.fg(allAnswered() ? "success" : "dim", reviewText),
            );
            addPrefixed(" ", tabs.join(" "));
            lines.push("");
          }

          if (currentTab === questions.length) {
            addPrefixed(" ", theme.fg("accent", theme.bold("Review answers")));
            lines.push("");
            questions.forEach((question, index) => {
              const choices = answerChoices(question, answers.get(index)!);
              addPrefixed(
                " ",
                `${theme.fg("muted", `${question.label}: `)}${theme.fg(
                  "text",
                  choices
                    .map((choice) => (choice.custom ? `wrote “${choice.label}”` : choice.label))
                    .join(", "),
                )}`,
              );
            });
            lines.push("");
            addPrefixed(" ", theme.bg("selectedBg", theme.fg("text", " Submit answers ")));
            lines.push("");
            addPrefixed(" ", theme.fg("dim", "← return to questions • Enter submit • Esc cancel"));
          } else {
            const question = questions[currentTab]!;
            const answer = answers.get(currentTab);
            const cursor = cursors[currentTab]!;
            const customIndex = question.options.length;

            addPrefixed(" ", theme.fg("text", question.question));
            lines.push("");

            question.options.forEach((option, index) => {
              const active = cursor === index;
              const checked = answer?.selected.has(index) ?? false;
              const marker =
                question.mode === "multiple" ? (checked ? "[x]" : "[ ]") : `${index + 1}.`;
              addPrefixed(
                active ? theme.fg("accent", "> ") : "  ",
                theme.fg(active ? "accent" : "text", `${marker} ${option.label}`),
              );
              if (option.description) addPrefixed("      ", theme.fg("muted", option.description));
            });

            const customActive = cursor === customIndex;
            const customChecked = Boolean(answer?.custom);
            const customMarker =
              question.mode === "multiple"
                ? customChecked
                  ? "[x]"
                  : "[ ]"
                : `${customIndex + 1}.`;
            addPrefixed(
              customActive ? theme.fg("accent", "> ") : "  ",
              theme.fg(customActive ? "accent" : "text", `${customMarker} ${CUSTOM_LABEL}`),
            );
            if (answer?.custom) addPrefixed("      ", theme.fg("muted", answer.custom));

            if (question.mode === "multiple") {
              const doneActive = cursor === customIndex + 1;
              const enabled = isAnswered(answer);
              lines.push("");
              addPrefixed(
                doneActive ? theme.fg("accent", "> ") : "  ",
                theme.fg(doneActive && enabled ? "accent" : enabled ? "success" : "dim", "Done"),
              );
            }

            if (editingQuestion !== undefined) {
              lines.push("");
              addPrefixed(" ", theme.fg("muted", "Your answer:"));
              editor.render(Math.max(1, renderWidth - 2)).forEach((line) => lines.push(` ${line}`));
              if (editorError) addPrefixed(" ", theme.fg("warning", "Answer cannot be empty"));
              lines.push("");
              addPrefixed(" ", theme.fg("dim", "Enter submit • Shift+Enter newline • Esc go back"));
            } else {
              lines.push("");
              const help =
                question.mode === "multiple"
                  ? "↑↓ select • Space toggle • Enter edit/Done • Esc cancel"
                  : "↑↓ select • Enter choose/edit • Esc cancel";
              addPrefixed(" ", theme.fg("dim", isBatch ? `←→ tabs • ${help}` : help));
            }
          }

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          cachedWidth = width;
          cachedLines = lines;
          return lines;
        };

        return {
          get focused() {
            return focused;
          },
          set focused(value: boolean) {
            focused = value;
            editor.focused = value && editingQuestion !== undefined;
          },
          render,
          handleInput,
          invalidate() {
            cachedWidth = undefined;
            cachedLines = undefined;
            editor.invalidate();
          },
        };
      });

      if (result.cancelled) {
        return {
          content: [
            { type: "text", text: "User cancelled the questions without submitting answers." },
          ],
          details: result,
        };
      }

      const content = result.answers
        .map(
          (answer) => `${answer.label}: ${answer.choices.map((choice) => choice.label).join(", ")}`,
        )
        .join("\n");
      return { content: [{ type: "text", text: content }], details: result };
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("ask_user ")) +
          theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      return new Text(
        details.answers
          .map(
            (answer) =>
              `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label)}: ${answer.choices
                .map((choice) => choice.label)
                .join(", ")}`,
          )
          .join("\n"),
        0,
        0,
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const active = new Set(pi.getActiveTools());
    if (isTuiContext(ctx)) active.add(TOOL_NAME);
    else active.delete(TOOL_NAME);
    pi.setActiveTools([...active]);
  });
}
