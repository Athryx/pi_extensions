import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageFooter } from "./footer.js";
import { fetchUsage, footerText, usageDetails, type SubscriptionUsage } from "./usage.js";

const POLL_MS = 60_000;
const WIDGET = "codex-usage-adapter";

export default function codexUsage(pi: ExtensionAPI): void {
  let usage: SubscriptionUsage | undefined;
  let error: string | undefined;
  let footer: UsageFooter | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let lastPoll = 0;

  const cleanup = () => {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    pending = undefined;
    footer?.dispose();
    footer = undefined;
  };

  const poll = (ctx: ExtensionContext): Promise<void> => {
    if (pending) return pending;
    const current = generation;
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => abort.abort(), 15_000);
    timeout.unref?.();
    lastPoll = Date.now();
    pending = (async () => {
      try {
        const result = await fetchUsage(ctx, abort.signal);
        if (current !== generation || abort.signal.aborted) return;
        usage = result;
        error = undefined;
      } catch (cause) {
        if (current !== generation) return;
        // fetchUsage only throws sanitized errors; avoid printing auth resolver exceptions.
        error = cause instanceof Error && /^(Codex |Could not |No compatible |Usage polling)/.test(cause.message)
          ? cause.message : "Could not poll Codex usage. Check your subscription login with /login.";
        // Never present old percentages as current after an unsuccessful refresh.
      } finally {
        clearTimeout(timeout);
        if (current === generation) {
          pending = undefined;
          controller = undefined;
          footer?.refresh();
        }
      }
    })();
    return pending;
  };

  pi.on("session_start", (_event, ctx) => {
    cleanup();
    usage = undefined;
    error = undefined;
    lastPoll = 0;
    if (ctx.mode !== "tui") return;
    // Obtain the live TUI without taking over other extensions' footer/widgets.
    ctx.ui.setWidget(WIDGET, (tui, theme) => {
      // Pi may rebuild widgets without first disposing the previous instance.
      footer?.dispose();
      const adapter = new UsageFooter(tui, () => {
        const text = footerText(usage, !!error);
        // Rendering can outlive the session ctx during fork/resume/reload.
        return text ? theme.fg("dim", text) : "";
      });
      footer = adapter;
      return {
        render: () => { adapter.attach(); return []; },
        invalidate() {},
        dispose() {
          adapter.dispose();
          if (footer === adapter) footer = undefined;
        },
      };
    }, { placement: "belowEditor" });
    void poll(ctx);
    timer = setInterval(() => { void poll(ctx); }, POLL_MS);
    timer.unref?.();
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui" && Date.now() - lastPoll >= 30_000) void poll(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    if (ctx.mode === "tui") void poll(ctx);
  });
  pi.on("session_shutdown", cleanup);

  pi.registerCommand("usage", {
    description: "Poll Codex subscription limits, reset times, plan, and credits",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("Usage: /usage", "warning"); return; }
      const current = generation;
      await poll(ctx);
      // A session replacement may have invalidated the command ctx while polling.
      if (current !== generation) return;
      if (error || !usage) {
        ctx.ui.notify(error ?? "Codex usage unavailable.", "error");
        return;
      }
      // UI-only: account/subscription data is not persisted or added to model context.
      ctx.ui.notify(usageDetails(usage), "info");
    },
  });
}
