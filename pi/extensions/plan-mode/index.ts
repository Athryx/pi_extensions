import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isInteractive, registerInteractiveTool } from "../shared/interactive";

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

export function resolvePlanTarget(input: string, cwd: string): { file: string; description: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { file: "", description: "" };
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    const normalized = trimmed.endsWith(".md") || trimmed.endsWith(".markdown") ? trimmed : `${trimmed}.md`;
    const full = resolve(cwd, normalized);
    return { file: full, description: basename(full, ".md") };
  }
  if (trimmed.endsWith(".md") || trimmed.endsWith(".markdown")) {
    return { file: join(resolve(cwd, "plans"), trimmed), description: trimmed.replace(/\.(md|markdown)$/, "") };
  }
  if (!/\s/.test(trimmed)) {
    const safeName = trimmed.replace(/[^\p{L}\p{N}_-]/gu, "_");
    return { file: join(resolve(cwd, "plans"), `${safeName}.md`), description: trimmed };
  }
  const filename = planFilename(trimmed);
  return { file: join(resolve(cwd, "plans"), filename), description: trimmed };
}

export async function findDraftPlan(cwd: string): Promise<string | null> {
  const dir = resolve(cwd, "plans");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const candidates: { file: string; mtime: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "walkthrough.md") continue;
      const full = join(dir, entry.name);
      const st = await stat(full);
      candidates.push({ file: full, mtime: st.mtimeMs });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].file;
  } catch {
    return null;
  }
}

function getPlanInstructions(state: PlanState): string {
  const walkthroughFile = state.file ? join(dirname(state.file), "walkthrough.md") : "plans/walkthrough.md";
  if (state.file) {
    return `[PLAN MODE ACTIVE]
The user is requesting that you think and plan carefully before executing the upcoming task.
Topic: ${state.description || "Active plan"}
Designated plan file: ${state.file}

Carefully research the task, make sure that you and the user are aligned on the goals and requirements,
create a detailed implementation plan document, and get user approval on the plan before making any code changes
(besides ${state.file}) or running any modifying commands.

# Guidelines
- Establish a shared understanding of the task with the user. If there are any ambiguities, underspecified requirements,
or implicit assumptions, clarify them with the user before proceeding. Use ask_question (if available) or direct questions
to clarify key decisions or requirements; group independent questions when possible.
- Thoroughly research the codebase to establish a solid understanding of the relevant components, systems, dependencies, and architecture.
As you research, provide verbal updates of your research steps and thought process with the user, so they can follow along.
- Create an implementation plan document at ${state.file} that outlines your proposed execution strategy.
The only permitted file change before explicit user approval is writing or revising the plan at ${state.file}.
All tools remain available, but use them only for inspection and drafting the plan; do not make implementation changes or mutate project files.
- Put the plan in a folder called plans/ in the current working directory, unless the user specifies a location.
If the user specifies a name but not a full path, still name it that, but put it in the plans/ folder.
Make target directories if they do not exist.
- Only after the user explicitly approves the plan (via the /plan implement command or explicit user confirmation) should you proceed to execution.
- Only call finish_plan if the user explicitly asks to exit plan mode or approves/requests implementation; set approved accordingly.
- After implementation is approved and executed, verify that your changes have the desired effects e.g. run unit tests,
make sure code builds, etc. before claiming that the task is complete.
- After you've completed your task and verified that your solution works, create a walkthrough document at ${walkthroughFile} to summarize your work.

# Planning Mode Documents
When in planning mode, you should create two special documents: the Implementation Plan, and later, the Walkthrough.

# Implementation Plan
Path: ${state.file}

**Purpose**: A technical design document to present your implementation plan to the user for feedback and approval.
After reading the document, the user should understand the key technical details of your plan, and be able to make an informed decision on whether to approve it.
This document should be very detailed, including code snippets, diffs, mermaid diagrams, verification strategies, and background information.

**Format**: Use the following format, omitting any irrelevant sections:

## [Goal Description]
Provide a brief description of the problem, any background context, and what the change accomplishes.

## User Review Required
Document anything that requires user review or feedback, for example, breaking changes or significant design decisions. Use GitHub alerts (IMPORTANT/WARNING/CAUTION) to highlight critical items.

## Open Questions
Any clarifying or design questions for the user that will impact the implementation plan. Use GitHub alerts (IMPORTANT/WARNING/CAUTION) to highlight critical items.

## Proposed Changes
Group files by component (e.g., package, feature area, dependency layer) and order logically (dependencies first). Separate components with horizontal rules for visual clarity.

### [Component Name]
Summary of what will change in this component with explicit code snippets and diffs. For specific files, Use [NEW] and [DELETE] to demarcate new and deleted files, for example:
#### [MODIFY] file path
#### [NEW] file path
#### [DELETE] file path

## Verification Plan
Summary of how you will verify that your changes have the desired effects.

### Automated Tests
Exact commands to run automated tests

### Manual Verification
Instructions for what the user should manually verify.

# Walkthrough
Path: ${walkthroughFile}

**Purpose**: After completing work, summarize what you accomplished. Update an existing walkthrough for related follow-up work rather than creating a new one.

**Document**:
- Changes made
- What was tested
- Validation results

Embed screenshots and recordings to visually demonstrate UI changes and user flows.`;
  }

  return `[PLAN MODE ACTIVE]
The user is requesting that you think and plan carefully before executing the upcoming task.
Carefully research the task, make sure that you and the user are aligned on the goals and requirements,
create a detailed implementation plan document, and get user approval on the plan before making any code changes
(besides the plan file) or running any modifying commands.

# Guidelines
- Establish a shared understanding of the task with the user. If there are any ambiguities, underspecified requirements,
or implicit assumptions, clarify them with the user before proceeding. Use ask_question (if available) or direct questions
to clarify key decisions or requirements; group independent questions when possible.
- Thoroughly research the codebase to establish a solid understanding of the relevant components, systems, dependencies, and architecture.
As you research, provide verbal updates of your research steps and thought process with the user, so they can follow along.
- Create an implementation plan document that outlines your proposed execution strategy.
All tools remain available, but use them only for inspection and drafting the plan; do not make implementation changes or mutate project files.
- No plan path was specified. Put the plan in a folder called plans/ in the current working directory, unless the user specifies a location.
If the user specifies a name but not a full path, still name it that, but put it in the plans/ folder.
Name the plan file a short phrase related to what is being planned/implemented (e.g. plans/<plan_name>.md).
Make the plans/ folder if it does not exist.
- Only after the user explicitly approves the plan (via the /plan implement command or explicit user confirmation) should you proceed to execution.
- Only call finish_plan if the user explicitly asks to exit plan mode or approves/requests implementation; set approved accordingly.
- After implementation is approved and executed, verify that your changes have the desired effects e.g. run unit tests,
make sure code builds, etc. before claiming that the task is complete.
- After you've completed your task and verified that your solution works, create a walkthrough document at plans/walkthrough.md to summarize your work.

# Planning Mode Documents
When in planning mode, you should create two special documents: the Implementation Plan, and later, the Walkthrough.

# Implementation Plan
Path: plans/<plan_name>.md

**Purpose**: A technical design document to present your implementation plan to the user for feedback and approval.
After reading the document, the user should understand the key technical details of your plan, and be able to make an informed decision on whether to approve it.
This document should be very detailed, including code snippets, diffs, mermaid diagrams, verification strategies, and background information.

**Format**: Use the following format, omitting any irrelevant sections:

## [Goal Description]
Provide a brief description of the problem, any background context, and what the change accomplishes.

## User Review Required
Document anything that requires user review or feedback, for example, breaking changes or significant design decisions. Use GitHub alerts (IMPORTANT/WARNING/CAUTION) to highlight critical items.

## Open Questions
Any clarifying or design questions for the user that will impact the implementation plan. Use GitHub alerts (IMPORTANT/WARNING/CAUTION) to highlight critical items.

## Proposed Changes
Group files by component (e.g., package, feature area, dependency layer) and order logically (dependencies first). Separate components with horizontal rules for visual clarity.

### [Component Name]
Summary of what will change in this component with explicit code snippets and diffs. For specific files, Use [NEW] and [DELETE] to demarcate new and deleted files, for example:
#### [MODIFY] file path
#### [NEW] file path
#### [DELETE] file path

## Verification Plan
Summary of how you will verify that your changes have the desired effects.

### Automated Tests
Exact commands to run automated tests

### Manual Verification
Instructions for what the user should manually verify.

# Walkthrough
Path: plans/walkthrough.md

**Purpose**: After completing work, summarize what you accomplished. Update an existing walkthrough for related follow-up work rather than creating a new one.

**Document**:
- Changes made
- What was tested
- Validation results

Embed screenshots and recordings to visually demonstrate UI changes and user flows.`;
}

export default function (pi: ExtensionAPI) {
  let state: PlanState = { active: false, description: "", file: "", exitNotice: false };
  let planDirectory = "";

  function persist() { pi.appendEntry(STATE_KEY, { ...state }); }

  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus(STATE_KEY, state.active ? ctx.ui.theme.fg("warning", state.file ? `PLAN: ${basename(state.file)}` : "PLAN: active") : undefined);
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

  async function planIsWritten(file: string): Promise<boolean> {
    if (!file) return false;
    try { return (await lstat(file)).isFile(); }
    catch { return false; }
  }

  pi.on("session_start", (_event, ctx) => {
    state = { active: false, description: "", file: "", exitNotice: false };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_KEY && entry.data) {
        state = entry.data as PlanState;
      }
    }
    planDirectory = resolve(ctx.cwd, "plans");

    registerInteractiveTool(pi, {
      name: "finish_plan",
      label: "Finish Plan Mode",
      executionMode: "sequential",
      description: "Finish plan mode when the user explicitly asks to leave it or implement the plan. Set approved=true ONLY if the user explicitly approves/requests implementation; set false if they only ask to exit. Do nothing outside plan mode.",
      promptGuidelines: ["Do not call finish_plan unless plan mode is active and the user explicitly asks to exit or implement the plan."],
      parameters: Type.Object({
        approved: Type.Boolean({ description: "True only when the user explicitly approves or asks to implement the plan; false for exit without approval" }),
      }, { additionalProperties: false }),
      async execute(_id, params, _signal, _update, toolCtx) {
        if (!isInteractive(toolCtx)) throw new Error("Plan mode is only available to the interactive agent");
        if (!state.active) return { content: [{ type: "text", text: "Plan mode is not active; nothing changed." }], details: undefined };
        let file = state.file;
        if (params.approved) {
          if (!file) {
            const draft = await findDraftPlan(toolCtx.cwd);
            if (draft) file = state.file = draft;
          }
          if (!file || !(await planIsWritten(file))) {
            return { content: [{ type: "text", text: `Plan mode is still active. Write a plan in plans/ before approving it.` }], details: undefined };
          }
        }
        exit(toolCtx, params.approved);
        return { content: [{ type: "text", text: params.approved
          ? `The user explicitly approved the plan in ${file}. Plan mode is exited. Read the plan and implement it now.`
          : "Exited plan mode without approving the plan. Do not treat this as approval to implement it." }], details: undefined };
      },
    }, ctx);
    if (!isInteractive(ctx)) return;
    status(ctx);

    pi.registerCommand("plan", {
      description: "Plan mode: /plan [path|name|description], /plan implement, /plan exit, /plan status",
      handler: async (args, commandCtx) => {
        if (!isInteractive(commandCtx)) return;
        const sub = args.trim().toLowerCase();
        if (sub === "exit") {
          if (!state.active) {
            commandCtx.ui.notify("Plan mode is not active.", "warning");
            return;
          }
          exit(commandCtx, false);
          commandCtx.ui.notify("Plan mode exited without approval; the next prompt will include a reminder.", "info");
          return;
        }

        if (sub === "implement" || sub === "approve") {
          if (!state.active) {
            commandCtx.ui.notify("Plan mode is not active.", "warning");
            return;
          }
          let file = state.file;
          if (!file) {
            const draft = await findDraftPlan(commandCtx.cwd);
            if (draft) file = state.file = draft;
          }
          if (!file || !(await planIsWritten(file))) {
            commandCtx.ui.notify("Write a plan in plans/ before approving it.", "warning");
            return;
          }
          exit(commandCtx, true);
          pi.sendUserMessage(`I explicitly approve the plan in ${file}. Plan mode is exited. Read the plan and implement it now.`, { deliverAs: "followUp" });
          return;
        }

        if (sub === "status") {
          if (!state.active) {
            commandCtx.ui.notify("Plan mode is not active.", "info");
            return;
          }
          commandCtx.ui.notify(`Plan mode is active. Plan: ${state.file || "plans/<plan_name>.md (dynamic)"}`, "info");
          return;
        }

        let target: { file: string; description: string };
        try {
          target = resolvePlanTarget(args, commandCtx.cwd);
        } catch (error) {
          commandCtx.ui.notify((error as Error).message, "warning");
          return;
        }

        const targetDir = target.file ? dirname(target.file) : planDirectory;
        try {
          await mkdir(targetDir, { recursive: true });
          if (!(await lstat(targetDir)).isDirectory() || await realpath(targetDir) !== targetDir) {
            throw new Error(`${targetDir} must be a real directory, not a symlink`);
          }
        } catch (error) {
          commandCtx.ui.notify(`Cannot create directory: ${(error as Error).message}`, "error");
          return;
        }

        state.description = target.description;
        state.file = target.file;
        enter(commandCtx);
        commandCtx.ui.notify(
          target.file
            ? `Plan mode enabled. Next prompt will plan ${basename(target.file)}.`
            : "Plan mode enabled. Next prompt will plan the upcoming task.",
          "info",
        );
      },
    });
  });

  // input fires before Pi appends the user's prompt. A custom message sent here is
  // persisted immediately before that user message, without changing the system prompt.
  pi.on("input", (event, ctx) => {
    if (!isInteractive(ctx) || event.source !== "interactive") return;
    if (state.active) {
      pi.sendMessage({
        customType: "plan-mode-instructions",
        content: getPlanInstructions(state),
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
