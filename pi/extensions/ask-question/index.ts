import { truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type Focusable, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerInteractiveTool } from "../shared/interactive";

const questionSchema = Type.Object({
  question: Type.String({ description: "Question to show the user" }),
  choices: Type.Optional(Type.Array(Type.String(), { default: [], description: "Choices in display order; omit or use [] for a free-response question" })),
}, { additionalProperties: false });
const schema = Type.Object({
  questions: Type.Array(questionSchema, { minItems: 1, description: "All questions to ask the user in one form, in display order" }),
}, { additionalProperties: false });

type Question = { id: string; question: string; choices: string[] };
type Answer = { answer: string; choiceIndex?: number; notes: string };
type QuestionDetails = { question: string; choices: string[]; answer: Answer | null };
type BatchDetails = { questions: QuestionDetails[] };
type Pending = { question: Question; resolve: (answer: Answer | null) => void; signal: AbortSignal | undefined };

/** One TUI prompt for all questions, including any concurrently executing calls. */
async function showQuestions(ctx: ExtensionContext, pending: Pending[]): Promise<void> {
  const questions = pending.map((p) => p.question);
  const result = await ctx.ui.custom<Map<string, Answer> | null>((tui, theme, _keys, done) => {
    const complete = (value: Map<string, Answer> | null) => {
      pending.forEach((p) => p.signal?.removeEventListener("abort", cancel));
      done(value);
    };
    const cancel = () => complete(null);
    pending.forEach((p) => p.signal?.addEventListener("abort", cancel, { once: true }));
    if (pending.some((p) => p.signal?.aborted)) queueMicrotask(cancel);
    const answers = new Map<string, Answer>();
    const notes = new Map<string, string>();
    let tab = 0; // One tab per question, followed by Submit.
    const optionIndexes = questions.map(() => 0);
    let editing: "answer" | "notes" | null = null;
    let focused = false;
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      },
    };
    const editor = new Editor(tui, editorTheme);
    const refresh = () => tui.requestRender();
    const current = () => questions[tab];
    const allAnswered = () => questions.every((q) => answers.has(q.id));
    const moveTab = (direction: number) => {
      tab = Math.max(0, Math.min(questions.length, tab + direction));
      const destination = current();
      if (destination?.choices.length && answers.has(destination.id)) {
        optionIndexes[tab] = (answers.get(destination.id)?.choiceIndex ?? destination.choices.length + 1) - 1;
      }
    };
    const finishAnswer = (answer: Answer) => {
      const q = current();
      if (!q) return;
      answers.set(q.id, { ...answer, notes: notes.get(q.id) ?? "" });
      editing = null;
      moveTab(1);
      refresh();
    };
    editor.onSubmit = (value) => {
      const q = current();
      if (!q) return;
      if (editing === "notes") {
        notes.set(q.id, value.trim());
        const answer = answers.get(q.id);
        if (answer) answer.notes = value.trim();
      } else if (editing === "answer") {
        if (!value.trim()) return; // Do not submit an empty free-form answer.
        finishAnswer({ answer: value.trim(), notes: notes.get(q.id) ?? "" });
      }
      editing = null;
      refresh();
    };
    function handleInput(data: string) {
      if (editing) {
        if (matchesKey(data, Key.escape)) { editing = null; refresh(); return; }
        if (editing === "notes" && matchesKey(data, Key.tab)) {
          editor.onSubmit?.(editor.getText());
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) { complete(null); return; }
      const q = current();
      if (q && matchesKey(data, Key.tab)) {
        editing = "notes"; editor.setText(notes.get(q.id) ?? ""); refresh(); return;
      }
      if (matchesKey(data, Key.right) || matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
        moveTab(matchesKey(data, Key.right) ? 1 : -1);
        refresh(); return;
      }
      if (matchesKey(data, Key.enter)) {
        if (!q) { if (allAnswered()) complete(answers); return; }
        if (!q.choices.length || optionIndexes[tab] === q.choices.length) {
          editing = "answer"; editor.setText(answers.get(q.id)?.choiceIndex === undefined ? answers.get(q.id)?.answer ?? "" : ""); refresh(); return;
        }
        const index = optionIndexes[tab];
        finishAnswer({ answer: q.choices[index], choiceIndex: index + 1, notes: notes.get(q.id) ?? "" });
        return;
      }
      if (q && q.choices.length) {
        if (matchesKey(data, Key.up)) optionIndexes[tab] = Math.max(0, optionIndexes[tab] - 1);
        else if (matchesKey(data, Key.down)) optionIndexes[tab] = Math.min(q.choices.length, optionIndexes[tab] + 1);
        refresh();
      }
    }
    function render(width: number): string[] {
      const w = Math.max(1, width);
      const lines: string[] = [];
      const add = (prefix: string, value: string) => {
        const size = visibleWidth(prefix);
        if (size >= w) { lines.push(...wrapTextWithAnsi(prefix + value, w)); return; }
        wrapTextWithAnsi(value, w - size).forEach((line, i) => lines.push((i ? " ".repeat(size) : prefix) + line));
      };
      lines.push(theme.fg("accent", "─".repeat(w)));
      const tabs = questions.map((q, i) =>
        `${answers.has(q.id) ? "✓" : "○"} Q${i + 1}${notes.get(q.id) ? "*" : ""}`,
      ).concat("Submit");
      // Wrap the tab bar on narrow terminals.
      add(" ", tabs.map((label, i) => i === tab ? theme.bg("selectedBg", ` ${label} `) : ` ${label} `).join(" "));
      lines.push("");
      const q = current();
      if (!q) {
        add(" ", theme.fg("accent", "Submit answers"));
        questions.forEach((item, i) => {
          const answer = answers.get(item.id);
          const note = answer?.notes ? ` (notes: ${answer.notes.replace(/\s+/g, " ")})` : "";
          add(" ", `${i + 1}. ${answer?.answer ?? "(unanswered)"}${note}`);
        });
        add(" ", theme.fg(allAnswered() ? "success" : "warning", allAnswered() ? "Enter to submit" : "Answer every question before submitting"));
      } else {
        add(" ", theme.fg("text", q.question));
        lines.push("");
        if (q.choices.length) {
          [...q.choices, "Other (write your own answer)"].forEach((label, i) => {
            const saved = answers.get(q.id);
            const selected = saved?.choiceIndex === i + 1 ||
              (i === q.choices.length && saved !== undefined && saved.choiceIndex === undefined);
            const preview = i === q.choices.length && selected
              ? `: ${saved!.answer.replace(/\s+/g, " ").slice(0, 120)}${saved!.answer.length > 120 ? "…" : ""}`
              : "";
            add(i === optionIndexes[tab] ? theme.fg("accent", "> ") : "  ",
              theme.fg(i === optionIndexes[tab] ? "accent" : "text", `${i + 1}. ${label}${preview}${selected ? " ✓" : ""}`));
          });
        } else if (!editing) {
          add(" ", theme.fg("muted", answers.get(q.id)?.answer ?? "Enter to write your answer"));
        }
        if (notes.get(q.id) && editing !== "notes") add(" ", theme.fg("muted", `Notes: ${notes.get(q.id)}`));
        if (editing) {
          lines.push("");
          add(" ", theme.fg("muted", editing === "notes" ? "Notes:" : "Your answer:"));
          editor.render(Math.max(1, w - 2)).forEach((line) => add(" ", line));
        }
      }
      lines.push("");
      add(" ", theme.fg("dim", editing ? (editing === "notes" ? "Tab/Enter save notes • Shift+Enter newline • Esc back" : "Enter save & next • Shift+Enter newline • Esc back") : "Tab notes • ←→ questions/submit • ↑↓ choices • Enter select & next • Esc cancel"));
      lines.push(theme.fg("accent", "─".repeat(w)));
      return lines;
    }
    const component: Focusable & { render: (width: number) => string[]; handleInput: (data: string) => void; invalidate: () => void } = {
      get focused() { return focused; },
      set focused(value) { focused = value; editor.focused = value; },
      render, handleInput, invalidate() { editor.invalidate(); },
    };
    return component;
  });
  pending.forEach(({ question, resolve }) => resolve(result?.get(question.id) ?? null));
}

export default function (pi: ExtensionAPI) {
  // Register hidden headlessly: neither the tool nor its usage guidance is exposed.
  pi.on("session_start", (_event, ctx) => {
    let batch: Pending[] = [];
    let scheduled = false;
    registerInteractiveTool<typeof schema, BatchDetails | undefined>(pi, {
      name: "ask_question",
      label: "Ask Question",
      exposure: "model-only",
      executionMode: "parallel",
      description: "Ask the user one or more questions in a single tabbed form. Pass all questions in the questions array. Choices appear in the supplied order, followed by Other; omit choices for a free response. The user can also add optional notes.",
      promptSnippet: "Ask the user questions in one call with ordered choices or free-form responses and optional notes",
      promptGuidelines: [
        "Do not ask questions while a goal is running. Use your best judgement, or mark the goal as blocked if there is a genuine blocker.",
        "Use ask_question when a decision or clarification needs the user's input. Group all questions that can be asked together into the questions array in a single ask_question call, rather than making separate calls. Wait for all answers before proceeding.",
        "For ask_question multiple-choice questions, provide three meaningful choices when possible. Put the recommended choice first and append ' (Recommended)' to its text; if none is recommended, do not mark any choice as recommended. Do not include an Other choice yourself; ask_question adds it automatically.",
        "For an ask_question that needs an unrestricted free-form response, omit choices or pass an empty list instead of inventing choices. The user may add optional notes to any answer.",
      ],
      parameters: schema,
      async execute(id, params, signal, _onUpdate, toolCtx) {
        // Read the active branch at call time, including after reloads and tree navigation.
        const branch = toolCtx.sessionManager?.getBranch() ?? [];
        for (let index = branch.length - 1; index >= 0; index--) {
          const entry = branch[index];
          if (entry.type !== "custom" || entry.customType !== "project-goal-mode" || !entry.data) continue;
          const state = entry.data as { goal?: string | null; status?: string; generation?: number };
          if (typeof state.generation !== "number" || !["running", "blocked", "completed"].includes(state.status ?? "")) continue;
          if (state.status !== "completed" && (typeof state.goal !== "string" || !state.goal.trim())) continue;
          if (state.status === "running") {
            return {
              content: [{ type: "text" as const, text: "Can't ask questions in goal mode. Use your best judgement, or mark the goal as blocked if there is a genuine blocker." }],
              details: undefined,
            };
          }
          break;
        }
        const pending = params.questions.map((item, index) =>
          new Promise<QuestionDetails>((resolve) => {
            const choices = item.choices ?? [];
            batch.push({
              question: { id: `${id}:${index}`, question: item.question, choices },
              resolve: (answer) => resolve({ question: item.question, choices, answer }),
              signal,
            });
          }),
        );
        if (!scheduled) {
          scheduled = true;
          // Defer one event-loop tick to collect questions from concurrent calls as well.
          setTimeout(() => {
            const group = batch; batch = []; scheduled = false;
            void showQuestions(toolCtx, group).catch(() => group.forEach((item) => item.resolve(null)));
          }, 0);
        }
        const questions = await Promise.all(pending);
        const details = { questions };
        const text = questions.every((item) => item.answer === null)
          ? "User cancelled the questions."
          : JSON.stringify(details);
        return {
          content: [{ type: "text" as const, text: truncateHead(text, { maxBytes: 50_000, maxLines: 2_000 }).content }],
          details,
        };
      },
      renderCall(args, theme) {
        const questions = args.questions ?? [];
        return new Text(theme.fg("toolTitle", "ask_question ") + theme.fg("muted", questions.map((q) => q.question).join("\n")), 0, 0);
      },
      renderResult(result, _options, theme) {
        const questions = result.details?.questions;
        return new Text(questions?.length ? questions.map(({ question, answer }) =>
          answer ? theme.fg("success", `✓ ${question}: ${answer.answer}${answer.notes ? ` (notes: ${answer.notes})` : ""}`)
            : theme.fg("warning", `${question}: Cancelled`),
        ).join("\n") : theme.fg("warning", result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "Cancelled"), 0, 0);
      },
    }, ctx);
  });
}
