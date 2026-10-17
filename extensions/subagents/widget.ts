import { stripVTControlCharacters } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface WidgetRow {
  name: string;
  /** Short model name without provider, e.g. "Opus 5.5" or "GPT-6 Astra". */
  model?: string;
  thinking?: string;
  state: "running" | "queued" | "stopping";
  /** Tokens in the subagent's current context (latest response), not cumulative usage. */
  contextTokens?: number;
  contextWindow?: number;
}

const BAR_CELLS = 10;
const NAME_MAX = 24;
/** Narrower than this, the model column is dropped; name and context stay. */
const MODEL_MIN_WIDTH = 44;

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Clip plain text to `width` columns with a trailing ellipsis. truncateToWidth appends
 * a full SGR reset, which would cut the colour applied around the clipped segment.
 */
function clip(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  return `${stripVTControlCharacters(truncateToWidth(text, Math.max(0, width - 1), ""))}…`;
}

/** Thinking-level colours shared with Pi's editor border and the footer. */
const THINKING_COLORS: Record<string, ThemeColor> = {
  off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium",
  high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
};

/** Pi's model names without vendor prefixes, as the footer shows them. */
export function shortModelName(name: string): string {
  return name.replace(/^Claude /, "").replace(/\s+\((Global|US|EU|AU|APAC|JP)\)$/, "").trim();
}

/** Same thresholds as the Tokyo Night footer's context segment. */
function contextColor(percent: number): ThemeColor {
  return percent > 90 ? "error" : percent > 70 ? "warning" : "success";
}

function contextCell(row: WidgetRow, theme: Theme): string {
  if (row.state === "queued") return theme.fg("dim", "queued");
  const tokens = row.contextTokens ?? 0;
  if (!tokens) return theme.fg("dim", "starting");
  if (!row.contextWindow) return theme.fg("dim", formatTokens(tokens));
  const percent = Math.min(100, (tokens / row.contextWindow) * 100);
  const filled = Math.min(BAR_CELLS, Math.max(1, Math.round((percent / 100) * BAR_CELLS)));
  const color = contextColor(percent);
  const bar = theme.fg(color, "━".repeat(filled)) + theme.fg("dim", "━".repeat(BAR_CELLS - filled));
  return `${bar} ${theme.fg(color, `${Math.round(percent)}%`.padStart(4))}`;
}

function marker(row: WidgetRow, theme: Theme): string {
  if (row.state === "queued") return theme.fg("dim", "○");
  if (row.state === "stopping") return theme.fg("warning", "●");
  return theme.fg("borderAccent", "●");
}

/**
 * A header and one line per active subagent, each truncated to `width`:
 *
 *   Subagents  2 running · 1 queued
 *    ● review-auth   GPT-6 Astra xhigh   ━━━━━━━━━━  34%
 *    ○ tester        Opus 5.5 high                  queued
 */
export function renderWidget(rows: readonly WidgetRow[], theme: Theme, width: number): string[] {
  if (!rows.length || width <= 0) return [];
  const queued = rows.filter((row) => row.state === "queued").length;
  const running = rows.length - queued;
  const counts = [running ? `${running} running` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ");
  const lines = [`${theme.fg("accent", theme.bold("Subagents"))}  ${theme.fg("dim", counts)}`];
  const nameWidth = Math.min(NAME_MAX, Math.max(...rows.map((row) => row.name.length)));
  const cells = rows.map((row) => contextCell(row, theme));
  const modelWidth = Math.max(0, ...rows.map((row) => visibleWidth([row.model, row.thinking].filter(Boolean).join(" "))));
  const rightWidth = Math.max(...cells.map(visibleWidth));
  // Compact aligned columns (name, model, context) instead of stretching to the
  // pane's right edge, which leaves a wide empty gap on large terminals.
  const leftWidth = 3 + nameWidth;
  const room = Math.min(modelWidth, width - leftWidth - rightWidth - 4);
  const showModel = width >= MODEL_MIN_WIDTH && room >= 6 && modelWidth > 0;
  rows.forEach((row, index) => {
    const name = clip(row.name, nameWidth);
    const left = ` ${marker(row, theme)} ${theme.fg("accent", name)}${" ".repeat(nameWidth - visibleWidth(name))}`;
    const right = " ".repeat(rightWidth - visibleWidth(cells[index])) + cells[index];
    let middle = "";
    if (showModel) {
      // Clip the model first so the effort level stays visible.
      const effort = row.thinking ?? "";
      const model = clip(row.model ?? "", Math.max(0, room - (effort ? effort.length + 1 : 0)));
      const parts = [model ? theme.fg("customMessageLabel", model) : "", effort ? theme.fg(THINKING_COLORS[effort] ?? "muted", effort) : ""].filter(Boolean);
      middle = parts.join(" ");
      middle = `  ${middle}${" ".repeat(Math.max(0, room - visibleWidth(middle)))}`;
    }
    lines.push(`${left}${middle}  ${right}`);
  });
  return lines.map((line) => truncateToWidth(line, width, "…"));
}
