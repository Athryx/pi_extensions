import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface PlanState {
  active: boolean;
  description: string;
  file: string;
  exitNotice: boolean;
}

const STATE_KEY = "project-plan-mode";
export function planFilename(description: string): string {
  const name = description.trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]/gu, "_").replace(/_+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 100).toUpperCase();
  if (!name) throw new Error("Provide a plan description, e.g. /plan improve search");
  return `${name}.md`;
}

export default function (pi: ExtensionAPI) {
  let state: PlanState = { active: false, description: "", file: "", exitNotice: false };
  let planDirectory = "";

  function persist() { pi.appendEntry(STATE_KEY, { ...state }); }

  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus(STATE_KEY, state.active ? ctx.ui.theme.fg("warning", `PLAN: ${basename(state.file)}`) : undefined);
  }

  function enter(ctx: ExtensionContext) {
    state.active = true;
    state.exitNotice = false;
    status(ctx);
    persist();
  }

  function exit(ctx: ExtensionContext, approved: boolean) {
    state.active = false;
    state.exitNotice = !approved;
    status(ctx);
    persist();
  }

  async function planIsWritten(): Promise<boolean> {
    try { return (await lstat(state.file)).isFile(); }
    catch { return false; }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state = { active: false, description: "", file: "", exitNotice: false };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_KEY && entry.data) {
        state = entry.data as PlanState;
      }
    }
    planDirectory = resolve(ctx.cwd, "plans");

    pi.registerTool({
      name: "finish_plan",
      label: "Finish Plan Mode",
      description: "Finish plan mode when the user explicitly asks to leave it or implement the plan. Set approved=true ONLY if the user explicitly approves/requests implementation; set false if they only ask to exit. Do nothing outside plan mode.",
      promptGuidelines: ["Do not call finish_plan unless plan mode is active and the user explicitly asks to exit or implement the plan."],
      parameters: Type.Object({
        approved: Type.Boolean({ description: "True only when the user explicitly approves or asks to implement the plan; false for exit without approval" }),
      }, { additionalProperties: false }),
      async execute(_id, params, _signal, _update, toolCtx) {
        if (!state.active) return { content: [{ type: "text", text: "Plan mode is not active; nothing changed." }] };
        if (params.approved && !(await planIsWritten())) {
          return { content: [{ type: "text", text: `Plan mode is still active. Write the plan at ${state.file} before approving it.` }] };
        }
        const file = state.file;
        exit(toolCtx, params.approved);
        return { content: [{ type: "text", text: params.approved
          ? `The user explicitly approved the plan in ${file}. Plan mode is exited. Read the plan and implement it now.`
          : "Exited plan mode without approving the plan. Do not treat this as approval to implement it." }] };
      },
    });
    status(ctx);

    pi.registerCommand("plan", {
      description: "Begin planning: /plan <description>",
      handler: async (args, commandCtx) => {
        if (commandCtx.mode !== "tui") return;
        let filename: string;
        try { filename = planFilename(args); }
        catch (error) { commandCtx.ui.notify((error as Error).message, "warning"); return; }
        try {
          await mkdir(planDirectory, { recursive: true });
          if (!(await lstat(planDirectory)).isDirectory() || await realpath(planDirectory) !== planDirectory) {
            throw new Error("plans/ must be a real directory, not a symlink");
          }
        } catch (error) {
          commandCtx.ui.notify(`Cannot create plans/: ${(error as Error).message}`, "error");
          return;
        }
        state.description = args.trim();
        state.file = join(planDirectory, filename);
        enter(commandCtx);
        commandCtx.ui.notify(`Plan mode enabled. Next prompt will plan ${filename}.`, "info");
      },
    });

    pi.registerCommand("implement", {
      description: "Approve and implement the active plan: /implement",
      handler: async (args, commandCtx) => {
        if (commandCtx.mode !== "tui") return;
        if (args.trim() || !state.active) {
          commandCtx.ui.notify("Use /implement (no arguments) while plan mode is active.", "warning"); return;
        }
        const file = state.file;
        if (!(await planIsWritten())) {
          commandCtx.ui.notify(`Write the plan at ${file} before approving it.`, "warning");
          return;
        }
        exit(commandCtx, true);
        pi.sendUserMessage(`I explicitly approve the plan in ${file}. Plan mode is exited. Read the plan and implement it now.`, { deliverAs: "followUp" });
      },
    });

    pi.registerCommand("exit-plan", {
      description: "Leave plan mode without approving implementation",
      handler: async (_args, commandCtx) => {
        if (commandCtx.mode !== "tui" || !state.active) {
          commandCtx.ui.notify("Plan mode is not active.", "warning"); return;
        }
        exit(commandCtx, false);
        commandCtx.ui.notify("Plan mode exited without approval; the next prompt will include a reminder.", "info");
      },
    });
  });

  // input fires before Pi appends the user's prompt. A custom message sent here is
  // persisted immediately before that user message, without changing the system prompt.
  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive") return;
    if (state.active) {
      pi.sendMessage({
        customType: "plan-mode-instructions",
        content: `[PLAN MODE ACTIVE]\nThe user's plan topic is: ${JSON.stringify(state.description)}. The only permitted file change before explicit user approval is writing or revising the plan at ${state.file}. Do not change implementation code, configuration, tests, or any other files; do not run commands that change the project. All tools remain available, but use them only for inspection and drafting the plan; do not make implementation changes. Use ask_question to clarify ambiguities, important decisions, or missing requirements before settling the plan; group independent questions when possible. Draft a Markdown plan at ${state.file} with these sections:\n- Overview: brief overall description.\n- Goals: every goal the plan must achieve.\n- Decisions and tradeoffs: important decisions, why they were made, and alternatives or tradeoffs considered.\n- Proposed architecture: high-level approach.\n- Code changes: which parts of the code will change and how.\n- Obstacles or review needed (optional): unresolved risks or items needing user review; prefer asking questions rather than leaving avoidable ambiguities.\nOnly write the plan file, not the implementation. After writing it, summarize it to the user and wait for explicit approval (via /implement) or further instructions. Only call finish_plan if the user explicitly asks to exit plan mode or approves/requests implementation; set approved accordingly.`,
        display: false,
      }, event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined);
    } else if (state.exitNotice) {
      pi.sendMessage({
        customType: "plan-mode-exit-notice",
        content: "[PLAN MODE EXITED WITHOUT APPROVAL] The user exited plan mode without approving the plan. Do not interpret exiting as approval to implement the plan. Follow their current request; ask for explicit approval before implementing that plan.",
        display: false,
      }, event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined);
      state.exitNotice = false;
      persist();
    }
  });

}
