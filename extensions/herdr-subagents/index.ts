import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanup, scopeFor, status } from "./core.ts";

// No tools, prompt injections, polling, model calls, or automatic follow-up turns.
export default function herdrSubagents(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== "1" || process.env.PI_HERDR_WORKER === "1") return;
  const finish = async (ctx: ExtensionContext, cancel = false) => {
    try {
      const closed = await cleanup(scopeFor(ctx.sessionManager.getSessionId()), cancel);
      if (closed.length && ctx.hasUI) ctx.ui.notify(`Closed ${closed.length} subagent pane(s).`, "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Subagent cleanup: ${String(error)}`, "warning");
    }
  };
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.isIdle()) await finish(ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    // Reload preserves active jobs; leaving the parent session cancels its workers.
    // Reports/logs remain available on disk, even for unread or interrupted workers.
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
