# ask_question

Project-local interactive TUI tool. Run `/reload` to load it after adding the extension.

`ask_question({ questions: [{ question: string, choices?: string[] }, ...] })` asks one or more questions in a single tabbed form. The `questions` array must be non-empty; extra fields are rejected at both the top level and within each question. This replaces the previous top-level `question`/`choices` arguments.

Each question displays choices in the given order, followed by **Other** for a written answer. Omit `choices` or pass `[]` for a free-response question. The user can press Tab on a question to open an inline notes box. All answers return after the form is submitted, in input order, as `{ questions: [{ question, choices, answer: { answer, choiceIndex?, notes } }] }`. Escape cancels the whole form (each answer is `null`). Concurrent calls still share a form, but the system-prompt guidelines direct the agent to group all questions that can be asked together into **one tool call**, provide three choices with a first-choice recommendation when applicable, and use no choices for free-form questions. The tool and its prompt guidelines are not registered in headless or RPC modes.

Example:
```json
{"questions":[{"question":"Which approach?","choices":["A (Recommended)","B","C"]},{"question":"Any constraints?"}]}
```

Controls: Left/Right switch questions and reach Submit; Tab opens notes on the current question (Tab or Enter saves notes). Up/Down move through choices, Enter selects or saves an answer, Shift+Enter inserts a newline in an editor, and Escape backs out of editing or cancels the form. Returning to a question highlights its saved choice. A saved Other answer shows a preview in the choice list; selecting Other again opens the editor with that answer prefilled. Select Submit and press Enter after answering all questions.

Run tests: `node --test .pi/extensions/ask-question/test.cjs`.
