import { stripVTControlCharacters } from "node:util";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  ansiColor,
  ansiForeground,
  RESET_BACKGROUND,
  RESET_FOREGROUND,
  sessionAccent,
  usesExactTokyoNight,
} from "./colors.ts";
import type { StatusLineState } from "./state.ts";
import { currentAgentTitle, renderTopBorder } from "./status-line.ts";

const TOKYO_NIGHT_ULTRAVIOLET = "#bb9af7";
const TOKYO_NIGHT_BACKGROUND = "#1a1b26";
// pi-tui 1.3.0 editors emit these APC markers around the fake cursor cell; the
// TUI converts them to reverse video (\x1b[7m/\x1b[27m) only after every
// component has rendered. A focused cursor is CURSOR_MARKER immediately followed
// by FAKE_CURSOR_START; with the hardware cursor shown the TUI drops that fake
// cursor only if nothing separates the two (tui.js FOCUSED_FAKE_CURSOR).
// pi-tui exports CURSOR_MARKER and renderFakeCursor() but not the fake markers.
const FAKE_CURSOR_PATTERN = /((?:\x1b_pi:c\x07)?)(\x1b_pi:fc\x07)([\s\S]*?)(\x1b_pi:\/fc\x07|$)/g;

export function styleCaret(line: string, theme: Theme): string {
  if (!line.includes("\x1b_pi:fc\x07")) return line;

  // Keep the markers: the TUI drops them for a focused cursor when the hardware
  // cursor is shown, otherwise turns them into reverse video. Colors set here
  // are swapped by that reverse video, so the foreground becomes the caret fill.
  const prefix = usesExactTokyoNight(theme)
    ? `${ansiForeground(TOKYO_NIGHT_ULTRAVIOLET)}${ansiColor(TOKYO_NIGHT_BACKGROUND, 48)}`
    : theme.getFgAnsi("customMessageLabel");
  const reset = usesExactTokyoNight(theme) ? `${RESET_FOREGROUND}${RESET_BACKGROUND}` : RESET_FOREGROUND;
  return line.replace(
    FAKE_CURSOR_PATTERN,
    // Styling goes before both markers so CURSOR_MARKER stays adjacent to
    // FAKE_CURSOR_START; the color reset follows the closing marker.
    (_match, marker: string, start: string, glyph: string, end: string) =>
      `${prefix}${marker}${start}${glyph}${end}${reset}`,
  );
}

/**
 * Locate the base editor's bottom border structurally: the exact string its
 * renderBottomBorder() returned during this render. pi-tui's scroll border has
 * centered, left-aligned and arbitrarily ellipsized forms ("..", "─── ..."),
 * so matching its text is fragile. Content lines never equal it: the editor
 * reserves a trailing cursor column and does not apply borderColor to content.
 */
export function findBottomBorderIndex(lines: readonly string[], bottomBorder: string | undefined): number {
  return bottomBorder === undefined ? -1 : lines.indexOf(bottomBorder, 1);
}

export class EmptyFooter implements Component {
  #onDispose: () => void;

  constructor(onDispose: () => void) {
    this.#onDispose = onDispose;
  }

  render(): string[] {
    return [];
  }

  invalidate(): void {}

  dispose(): void {
    this.#onDispose();
  }
}

export class TokyoNightStatusEditor extends CustomEditor {
  #pi: ExtensionAPI;
  #ctx: ExtensionContext;
  #state: StatusLineState;
  #beforeRender: () => void;
  #bottomBorder: string | undefined;
  #removedBorderRow: number | undefined;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: StatusLineState,
    beforeRender: () => void,
    onReady: (requestRender: () => void) => void,
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
    this.#pi = pi;
    this.#ctx = ctx;
    this.#state = state;
    this.#beforeRender = beforeRender;
    onReady(() => tui.requestRender());
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.#removedBorderRow === undefined) return super.handleMouse(event);
    // Side chrome is not part of the autocomplete list's hit region.
    if (event.y >= this.#removedBorderRow && (event.x < 3 || event.x >= event.width - 3)) return undefined;
    // Render adds three columns on each side and removes the base bottom
    // border. Autocomplete consequently starts one row earlier on screen.
    return super.handleMouse({
      ...event,
      x: Math.max(0, Math.min(event.width - 7, event.x - 3)),
      y: event.y >= this.#removedBorderRow ? event.y + 1 : event.y,
      width: event.width - 6,
      height: event.height + 1,
    });
  }

  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    const border = super.renderBottomBorder(width, hiddenLineCount);
    this.#bottomBorder = border;
    return border;
  }

  render(width: number): string[] {
    this.#removedBorderRow = undefined;
    this.#bottomBorder = undefined;
    this.#beforeRender();
    const agentTitle = currentAgentTitle(this.#pi);
    this.borderColor = agentTitle
      ? (text: string) =>
          sessionAccent(this.#ctx.ui.theme, agentTitle, text)
      : (text: string) => this.#ctx.ui.theme.fg("border", text);

    if (width < 8) return super.render(width);

    const lines = super.render(width - 6);
    if (lines.length === 0) return lines;
    const bottomBorderIndex = findBottomBorderIndex(lines, this.#bottomBorder);
    if (bottomBorderIndex === -1) return super.render(width);
    this.#removedBorderRow = bottomBorderIndex;

    const scrollIndicators: string[] = [];
    const topScrollIndicator = stripVTControlCharacters(lines[0]).match(/↑\s+\d+\s+more/)?.[0];
    if (topScrollIndicator) scrollIndicators.push(topScrollIndicator);
    const bottomScrollIndicator = stripVTControlCharacters(lines[bottomBorderIndex]!).match(
      /↓\s+\d+\s+more/,
    )?.[0];
    if (bottomScrollIndicator) scrollIndicators.push(bottomScrollIndicator);

    const rendered = [
      renderTopBorder(
        this.#pi,
        this.#ctx,
        this.#state,
        scrollIndicators.length > 0 ? scrollIndicators.join(" · ") : undefined,
        agentTitle,
        this.borderColor,
        width,
      ),
    ];
    const lastContentIndex = bottomBorderIndex - 1;
    for (let index = 1; index < bottomBorderIndex; index++) {
      const leftChrome = index === lastContentIndex ? "╰─ " : "│  ";
      const rightChrome = index === lastContentIndex ? " ─╯" : "  │";
      const content = styleCaret(lines[index]!, this.#ctx.ui.theme);
      rendered.push(`${this.borderColor(leftChrome)}${content}${this.borderColor(rightChrome)}`);
    }
    for (let index = bottomBorderIndex + 1; index < lines.length; index++) {
      rendered.push(`   ${lines[index]}   `);
    }
    return rendered;
  }
}
