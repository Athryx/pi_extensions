import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_KEY = "project-goal-mode";
const REMINDER_KEY = "project-goal-reminder";
type GoalStatus = "running" | "completed" | "blocked";
interface GoalState {
  goal: string | null;
  status: GoalStatus;
  reason?: string;
  generation: number;
}

const emptyState = (): GoalState => ({ goal: null, status: "completed", generation: 0 });

export default function (pi: ExtensionAPI) {
  let state = emptyState();

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const key = STATE_KEY;
    if (!state.goal) {
      ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
      return;
    }
    const color = state.status === "blocked" ? "warning" : "accent";
    ctx.ui.setStatus(key, ctx.ui.theme.fg(color, `GOAL: ${state.status}`));
    const goal = state.goal.replace(/\s+/g, " ");
    const reason = state.status === "blocked" && state.reason ? ` — ${state.reason.replace(/\s+/g, " ")}` : "";
    // A short fixed maximum keeps even simple non-TUI renderers from flooding the screen.
    const summary = `${goal}${reason}`;
    ctx.ui.setWidget(key, [`Goal: ${summary.length > 180 ? `${summary.slice(0, 177)}...` : summary}`]);
  }

  function restore(ctx: ExtensionContext) {
    state = emptyState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_KEY || !entry.data) continue;
      const data = entry.data as GoalState;
      if (typeof data.generation !== "number" || !["running", "blocked", "completed"].includes(data.status)) continue;
      if (data.status !== "completed" && (typeof data.goal !== "string" || !data.goal.trim())) continue;
      state = { goal: data.status === "completed" ? null : data.goal, status: data.status, reason: data.reason, generation: data.generation };
    }
    render(ctx);
  }

  function update(ctx: ExtensionContext, goal: string | null, status: GoalStatus, reason?: string) {
    state = { goal, status, reason, generation: state.generation + 1 };
    pi.appendEntry(STATE_KEY, { ...state });
    render(ctx);
  }

  function setGoal(ctx: ExtensionContext, goal: string): string {
    const text = goal.trim();
    if (!text) return "A nonempty goal is required.";
    update(ctx, text, "running");
    return `Goal running: ${text}`;
  }

  function setStatus(ctx: ExtensionContext, status: GoalStatus, reason: string | undefined, fromAgent: boolean): string {
    if (!state.goal) return "No current goal. Set a goal first.";
    if (status === "running" && state.status !== "blocked") return "Only a blocked goal can be resumed.";
    if (fromAgent && status !== "running" && !reason?.trim()) {
      return `A reason explaining the evidence for ${status} is required.`;
    }
    const goal = state.goal;
    update(ctx, status === "completed" ? null : goal, status, reason?.trim() || undefined);
    return status === "completed" ? `Goal completed and cleared: ${goal}` : `Goal ${status}: ${goal}${reason?.trim() ? ` (${reason.trim()})` : ""}`;
  }

  function kickoff(text: string, ctx: ExtensionContext) {
    pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  pi.registerTool({
    name: "set_goal", label: "Set Goal",
    description: "Set or replace the current goal and start running it. Call only when the user explicitly requests setting a goal.",
    promptGuidelines: ["Call set_goal only when the user explicitly asks to set a goal; do not turn ordinary requests into goals."],
    parameters: Type.Object({ goal: Type.String({ description: "The user's explicit goal" }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const message = setGoal(ctx, params.goal);
      return { content: [{ type: "text", text: message }] };
    },
  });

  pi.registerTool({
    name: "set_goal_status", label: "Set Goal Status",
    description: "Update an existing goal. For completed or blocked, supply a reason explaining strong evidence for that status; never invent evidence. Use running only when the user asks to resume a blocked/interrupted goal. Completed clears the goal.",
    promptGuidelines: ["Call set_goal_status(completed or blocked) only with strong evidence, included in reason. Call set_goal_status(running) only when the user asks to resume a blocked goal."],
    parameters: Type.Object({
      status: StringEnum(["running", "completed", "blocked"] as const),
      reason: Type.Optional(Type.String({ description: "Explanation including evidence when completed or blocked" })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const message = setStatus(ctx, params.status, params.reason, true);
      return { content: [{ type: "text", text: message }] };
    },
  });

  pi.registerCommand("goal", {
    description: "Set a goal or manage it: /goal <goal> | resume | pause | stop",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        if (ctx.hasUI) ctx.ui.notify(state.goal ? `Goal (${state.status}): ${state.goal}${state.reason ? ` — ${state.reason}` : ""}` : "No goal. Use /goal <goal> to start one.", "info");
        return;
      }
      if (text === "pause" || text === "stop" || text === "resume") {
        const status = text === "pause" ? "blocked" : text === "stop" ? "completed" : "running";
        const previous = state;
        const result = setStatus(ctx, status, undefined, false);
        if (ctx.hasUI) ctx.ui.notify(result, previous === state ? "warning" : "info");
        if (text === "resume" && previous !== state && state.goal) kickoff(`Resume working on the current goal: ${state.goal}`, ctx);
        return;
      }
      const result = setGoal(ctx, text);
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      kickoff(`Work on this goal: ${state.goal}`, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\n\nGoal mode: Only call set_goal when the user explicitly asks to set a goal. Only call set_goal_status(completed/blocked) when you have strong evidence, and explain that evidence in the reason argument. Call set_goal_status(running) only if the user asks to resume an interrupted blocked goal. Do not declare a running goal finished without updating its status; if it is still running, keep working.",
  }));

  // A queued reminder may become stale if a user pauses, stops, or replaces the goal.
  // Remove it from LLM context even if Pi already queued the follow-up turn.
  pi.on("context", (event) => ({
    messages: event.messages.filter((message) => {
      if (message.role !== "custom" || message.customType !== REMINDER_KEY) return true;
      const details = message.details as { goal?: string; generation?: number } | undefined;
      return !!state.goal && state.status === "running" && details?.goal === state.goal && details.generation === state.generation;
    }),
  }));

  pi.on("agent_end", (event, ctx) => {
    if (!state.goal || state.status !== "running" || ctx.hasPendingMessages() || ctx.signal?.aborted) return;
    const last = event.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop" || last.content.some((item) => item.type === "toolCall")) return;
    const { goal, generation } = state;
    pi.sendMessage({
      customType: REMINDER_KEY, display: false,
      details: { goal, generation },
      content: `Current goal: ${JSON.stringify(goal)}. Check whether it is completed or blocked. If there is strong evidence for either, call set_goal_status with that status and explain the evidence in reason. Otherwise keep working on the goal; do not just finish with a final answer.`,
    }, { deliverAs: "followUp", triggerTurn: true });
  });
}
