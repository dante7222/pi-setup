import { DynamicBorder, getMarkdownTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { escapeSessionGroupDisplay } from "./display.ts";

/** Bounded in both regular and fullscreen Pi; regular custom UI does not scroll itself. */
export function createSessionGroupMarkdownViewer(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: () => void,
  title: string,
  content: string,
): Component {
  const safeContent = escapeSessionGroupDisplay(content);
  let markdown = new Markdown(safeContent, 1, 0, getMarkdownTheme());
  const border = new DynamicBorder((text: string) => theme.fg("accent", text));
  let offset = 0;
  let viewport = 1;
  let totalLines = 0;
  const keys = (id: "tui.select.pageUp" | "tui.select.pageDown" | "tui.select.cancel") =>
    keybindings.getKeys(id).join("/") || "unbound";

  return {
    render(width) {
      if (width <= 0) return [];
      const height = Math.max(1, tui.terminal.rows - 2);
      const framed = height >= 5;
      viewport = Math.max(1, height - (framed ? 4 : 0));
      const lines = markdown.render(width);
      totalLines = lines.length;
      offset = Math.max(0, Math.min(offset, totalLines - viewport));
      const visible = lines.slice(offset, offset + viewport).map((line) => truncateToWidth(line, width));
      if (!framed) return visible;
      const position = totalLines === 0 ? "0/0" : `${offset + 1}–${Math.min(totalLines, offset + viewport)}/${totalLines}`;
      const hint = `${position}  ${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")} scroll · ${keys("tui.select.cancel")} close`;
      return [
        ...border.render(width),
        truncateToWidth(theme.fg("accent", theme.bold(escapeSessionGroupDisplay(title))), width),
        ...visible,
        truncateToWidth(theme.fg("dim", hint), width),
        ...border.render(width),
      ];
    },
    invalidate() {
      // Recreate themed Markdown as well as invalidating wrapped-line caches.
      markdown = new Markdown(safeContent, 1, 0, getMarkdownTheme());
    },
    handleInput(data) {
      if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
        done();
        return;
      }
      if (keybindings.matches(data, "tui.select.pageUp")) offset -= viewport;
      else if (keybindings.matches(data, "tui.select.pageDown")) offset += viewport;
      else if (keybindings.matches(data, "tui.select.up")) offset--;
      else if (keybindings.matches(data, "tui.select.down")) offset++;
      else return;
      offset = Math.max(0, Math.min(offset, totalLines - viewport));
      tui.requestRender();
    },
    handleMouse(event) {
      if (event.type !== "wheel" || !event.wheelDelta) return undefined;
      offset = Math.max(0, Math.min(offset + event.wheelDelta, totalLines - viewport));
      tui.requestRender();
      return { handled: true };
    },
  };
}
