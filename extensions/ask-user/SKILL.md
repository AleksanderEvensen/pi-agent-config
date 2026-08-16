---
name: ask-user
description: Has information on how to use the `ask_user` tool in pi. This helps agents know how to formulate questions
---

# Ask User

Use `ask_user` when you need the user to choose between concrete options before acting.

- Ask one question, or batch up to five independent questions.
- Give each question 1–6 concise options.
- Use `mode: "single"` (the default) for one choice, or `mode: "multiple"` when several options may be selected.
- A custom-answer option is always added, so do not use this tool for free-text-only questions.
- Batch only independent questions; ask dependent questions separately.
- Keep labels and descriptions short. Mark a recommended option in its description when useful.

Example:

```json
{
  "questions": [
    {
      "question": "Which approach should I use?",
      "options": [
        { "label": "Minimal change", "description": "Recommended; smallest diff" },
        { "label": "Full refactor" }
      ]
    }
  ]
}
```

The tool is available only when this interactive ask-user extension is active. If the user cancels, continue without guessing or ask again later when appropriate.

Tool input schema (AskUserParams is what is used in the tool):

```ts
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
```
