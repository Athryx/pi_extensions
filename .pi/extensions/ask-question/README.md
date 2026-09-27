# ask_question

Project-local interactive TUI tool. Run `/reload` to load it after adding the extension.

`ask_question({ question: string, choices?: string[] })` displays choices in the given order, followed by **Other** for a written answer. Omit `choices` or pass `[]` for a free-response question. The user can press Tab on a question to open an inline notes box. Multiple calls made together are shown in one form; all results return after the form is submitted. Escape cancels the whole form. The tool is not registered in headless or RPC modes. Its system-prompt guidelines (also TUI-only) ask the model to batch independent questions in one turn, provide three choices with a first-choice recommendation when applicable, and use no choices for free-form questions.

Controls: Left/Right switch questions and reach Submit; Tab opens notes on the current question (Tab or Enter saves notes). Up/Down move through choices, Enter selects or saves an answer, Shift+Enter inserts a newline in an editor, and Escape backs out of editing or cancels the form. Returning to a question highlights its saved choice. A saved Other answer shows a preview in the choice list; selecting Other again opens the editor with that answer prefilled. Select Submit and press Enter after answering all questions.

Run tests: `node --test .pi/extensions/ask-question/test.cjs`.
