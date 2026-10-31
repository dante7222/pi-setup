import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "rex-terminal-title";

export default function rexTerminalTitle(pi: ExtensionAPI): void {
  if (process.env.TERM_PROGRAM !== "rex") return;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // A zero-line widget gives us the public terminal and disposal lifecycle
    // without occupying a footer/editor slot or adding visible content.
    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      const terminal = tui.terminal;
      const originalSetTitle = terminal.setTitle;
      const cwd = basename(ctx.cwd);
      const suffix = ` - ${cwd}`;
      let active = true;
      // Pi rewrites its title after session_start and on renames. Filter those
      // writes at the terminal instead of racing them with a deferred override.
      const setTitle = (title: string): void => {
        if (active && title.startsWith("π - ")) {
          title = title.slice("π - ".length);
          if (title.endsWith(suffix)) title = title.slice(0, -suffix.length);
        }
        originalSetTitle.call(terminal, title);
      };
      terminal.setTitle = setTitle;

      const name = pi.getSessionName();
      ctx.ui.setTitle(name ? `π - ${name} - ${cwd}` : `π - ${cwd}`);

      return {
        render: () => [],
        invalidate() {},
        dispose() {
          active = false;
          if (terminal.setTitle === setTitle) terminal.setTitle = originalSetTitle;
        },
      };
    }, { placement: "belowEditor" });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
    }
  });
}
