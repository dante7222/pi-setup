import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { agentDirectory, cleanup, scopeFor, status } from "./core.ts";

// No tools, prompt injections, polling, model calls, or automatic follow-up turns.
export default function herdrSubagents(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== "1" || process.env.PI_HERDR_WORKER === "1") return;
  // Anchor relative paths before a session switch changes cwd; shell tools inherit it.
  process.env.PI_CODING_AGENT_DIR = agentDirectory();
  const finish = async (ctx: ExtensionContext, cancel = false) => {
    try {
      const closed = await cleanup(scopeFor(ctx.sessionManager.getSessionId()), cancel);
      if (closed.length && ctx.hasUI) ctx.ui.notify(`Closed ${closed.length} subagent pane(s).`, "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Subagent cleanup: ${String(error)}`, "warning");
    }
  };
  let cancellation: Promise<void> = Promise.resolve();
  let cancelRequested = false;
  let failedRun = false;
  let generation = 0;
  let retryStop = false;
  let removeInput: (() => void) | undefined;
  const listeners = new Map<AbortSignal, () => void>();
  const unwatch = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    listeners.clear();
  };
  const cancel = (ctx: ExtensionContext) => {
    if (cancelRequested) return;
    cancelRequested = true;
    // Start independently of Pi's aborted tool/signal. finish resolves the session
    // scope synchronously, before any await or subsequent session replacement.
    cancellation = finish(ctx, true);
  };
  const watch = (signal: AbortSignal | undefined, ctx: ExtensionContext) => {
    if (!signal || listeners.has(signal)) return;
    const listener = () => cancel(ctx);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  };
  pi.on("session_start", (event, ctx) => {
    // Reload can replace this extension during retry backoff, where no new
    // agent_end will arrive. Restore eligibility, not cancellation intent.
    if (event.reason === "reload" && !ctx.signal && !ctx.isIdle()) {
      const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      failedRun = last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "error";
    }
    watch(ctx.signal, ctx);
    removeInput?.();
    if (ctx.mode === "tui") removeInput = ctx.ui.onTerminalInput((data) => {
      // Pi exposes no abort signal during retry backoff. Observe the configured
      // Stop action without consuming it; require subsequent idle settlement.
      if (failedRun && !ctx.signal && !ctx.isIdle() && getKeybindings().matches(data, "app.interrupt")) retryStop = true;
    });
  });
  pi.on("before_agent_start", async () => { await cancellation; });
  pi.on("agent_start", async (_event, ctx) => {
    // Also covers extension-triggered runs, which bypass before_agent_start.
    const current = ++generation;
    const signal = ctx.signal;
    await cancellation;
    if (current !== generation) return;
    unwatch();
    cancelRequested = false;
    failedRun = false;
    retryStop = false;
    watch(signal, ctx);
  });
  pi.on("session_before_compact", (event, ctx) => {
    // Auto-compaction has its own signal while the low-level agent is idle.
    if (event.reason !== "manual") watch(event.signal, ctx);
  });
  pi.on("agent_end", (event) => {
    const last = event.messages.findLast((message) => message.role === "assistant");
    failedRun = last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    // Do not confuse an ordinary provider failure with an explicit Stop.
    if (!ctx.isIdle()) return;
    const current = generation;
    if (retryStop) cancel(ctx);
    await cancellation;
    // An earlier subscriber, or one running during the await, may start a run.
    if (current !== generation || !ctx.isIdle()) return;
    unwatch();
    if (!cancelRequested) await finish(ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    // Detach before reload disposes/aborts the old runtime. Reload alone must not
    // cancel workers, but an already requested Stop still finishes its cleanup.
    unwatch();
    removeInput?.();
    removeInput = undefined;
    await cancellation;
    await finish(ctx, event.reason !== "reload");
  });
  pi.registerCommand("subagents", {
    description: "Show Herdr jobs; /subagents close or cancel (all owned panes)",
    handler: async (args, ctx) => {
      if (args.trim() === "close") return finish(ctx);
      if (args.trim() === "cancel") {
        if (await ctx.ui.confirm("Cancel subagents?", "Stop and close every subagent pane owned by this session? Saved reports remain.")) await finish(ctx, true);
        return;
      }
      if (args.trim()) { ctx.ui.notify("Usage: /subagents [close|cancel]", "warning"); return; }
      try {
        const scope = scopeFor(ctx.sessionManager.getSessionId());
        ctx.ui.notify(`${JSON.stringify(await status(scope), null, 2)}\n${scope.root}`, "info");
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
}
