import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { normalizeAgentTitle } from "./agent-title.ts";
import { isCodexFastModeRequested } from "./codex-fast-mode.ts";
import { RESET_ALL, sessionAccent, tone } from "./colors.ts";
import type { ContextTokenEstimate } from "./context-usage.ts";
import type { StatusLineState } from "./state.ts";
import { formatFirstTokenLatency } from "./throughput.ts";

// Visual layout adapted from oh-my-pi's MIT-licensed editor status line.
export const LEGACY_SESSION_NAME_STATUS_KEY = "ventris-session-name";
export const LEGACY_TPS_STATUS_KEY = "ventris-tps";
export const PRIME_AGENT_WIDGET_KEY = "tokyo-night-footer";
const TPS_ICON_NERD = "󰓅";
const TPS_ICON_FALLBACK = "⚡";
const TTFT_ICON_NERD = "";
const TTFT_ICON_FALLBACK = "◷";
const CONTEXT_ICON_NERD = "";
const CONTEXT_ICON_FALLBACK = "◫";
const GIT_BRANCH_ICON_NERD = "";
const GIT_BRANCH_ICON_FALLBACK = "⎇";
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const THINKING_COLORS: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

interface StatusSegment {
  id: string;
  content: string;
}

function sanitizeSingleLine(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

// CSI, OSC/DCS/APC/PM/SOS strings, two-byte escapes, or a lone ESC.
// Unterminated string sequences (OSC etc.) run to the end of the text.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)|[ -\/]*[0-~])?/g;
const SGR_SEQUENCE = /^\x1b\[[0-9;:]*m$/;

export function sanitizeStatusText(text: string): string {
  // Extension statuses may carry SGR styling. Keep only that: cursor movement,
  // erase, OSC (titles/hyperlinks) and other control sequences break the layout.
  return text
    .replace(ESCAPE_SEQUENCE, (sequence) => (SGR_SEQUENCE.test(sequence) ? sequence : ""))
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function supportsNerdIcons(): boolean {
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;

  const terminal = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((name) =>
    terminal.includes(name),
  );
}

export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  // Promote to the next unit after rounding: 9_999 -> 10k, 999_500 -> 1.0M.
  const thousands = count / 1_000;
  if (thousands < 10) {
    const text = thousands.toFixed(1);
    if (Number(text) < 10) return `${text}k`;
  }
  if (Math.round(thousands) < 1_000) return `${Math.round(thousands)}k`;
  const millions = count / 1_000_000;
  if (millions < 10) {
    const text = millions.toFixed(1);
    if (Number(text) < 10) return `${text}M`;
  }
  return `${Math.round(millions)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function truncatePath(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…";

  // Keep the longest grapheme suffix that fits; measure each grapheme once.
  const graphemes = Array.from(GRAPHEMES.segment(text), ({ segment }) => segment);
  let start = graphemes.length;
  let used = 0;
  while (start > 0) {
    const next = used + visibleWidth(graphemes[start - 1]!);
    if (next > width - 1) break;
    used = next;
    start--;
  }
  return `…${graphemes.slice(start).join("")}`;
}

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

function statusSegmentPriority(id: string): number {
  if (id === "scroll") return 95;
  if (id === "model") return 90;
  if (id === "fast") return 85;
  if (id.startsWith("status:")) return 85;
  if (id === "context") return 80;
  if (id === "path") return 75;
  if (id === "tps" || id === "ttft") return 65;
  if (id === "thinking") return 55;
  if (id === "git") return 45;
  if (id === "pi") return 20;
  return 0;
}

function leastImportantSegmentIndex(segments: readonly StatusSegment[]): number {
  let selectedIndex = 0;
  let selectedPriority = statusSegmentPriority(segments[0]!.id);
  for (let index = 1; index < segments.length; index++) {
    const priority = statusSegmentPriority(segments[index]!.id);
    if (priority <= selectedPriority) {
      selectedIndex = index;
      selectedPriority = priority;
    }
  }
  return selectedIndex;
}

function renderStatusGroup(
  segments: readonly StatusSegment[],
  direction: "left" | "right",
  theme: Theme,
  nerdIcons: boolean,
): string {
  if (segments.length === 0) return "";

  const separatorGlyph = nerdIcons
    ? direction === "left"
      ? ""
      : ""
    : direction === "left"
      ? "›"
      : "‹";
  const separator = tone(theme, "separator", separatorGlyph);
  return ` ${segments.map((segment) => segment.content).join(` ${separator} `)} `;
}

type ContextLevel = "normal" | "warning" | "error";

/**
 * Colors track Pi's auto-compaction threshold (window - compaction.reserveTokens)
 * when known, so red warns before compaction rather than ~2% before it.
 */
export function contextLevel(
  tokens: number | null | undefined,
  contextWindow: number,
  compactionReserveTokens: number | undefined,
): ContextLevel {
  if (tokens === null || tokens === undefined || contextWindow <= 0) return "normal";
  const threshold = compactionReserveTokens === undefined
    ? contextWindow
    : contextWindow - compactionReserveTokens;
  // Pi's shouldCompact() is `tokens > window - reserve`: a reserve that
  // consumes the whole window means every request is at the threshold.
  if (threshold <= 0) return "error";
  const percent = (tokens / threshold) * 100;
  return percent > 90 ? "error" : percent > 70 ? "warning" : "normal";
}

function contextSegment(
  contextWindow: number,
  compactionReserve: number | undefined,
  theme: Theme,
  contextEstimate: ContextTokenEstimate | undefined,
  loadedContextTokens: number | undefined,
  contextUsageInvalidated: boolean,
  contextUsageSnapshot: number | null | undefined,
  nerdIcons: boolean,
): string {
  // Rendering must never walk the session tree. Pi's getContextUsage() does;
  // snapshot it only at session/branch boundaries and use event-driven updates.
  const reportedContextTokens = contextUsageInvalidated ? undefined : contextUsageSnapshot;
  const isLoadedContextEstimate =
    contextEstimate === undefined &&
    reportedContextTokens === 0 &&
    loadedContextTokens !== undefined;
  const contextTokens =
    contextEstimate?.tokens ??
    (isLoadedContextEstimate ? loadedContextTokens : reportedContextTokens);
  // Pi's fallback may include estimated trailing messages or use another model's
  // tokenizer. Only a completed current-model response is labeled reported.
  const isEstimate = contextEstimate?.estimated ?? true;
  const display =
    contextWindow <= 0
      ? "?/?"
      : contextTokens === null || contextTokens === undefined
        ? `?/${formatTokens(contextWindow)}`
        : `${isEstimate ? "~" : ""}${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`;
  const text = withIcon(nerdIcons ? CONTEXT_ICON_NERD : CONTEXT_ICON_FALLBACK, display);

  const level = contextLevel(contextTokens, contextWindow, compactionReserve);
  if (level === "error") return theme.fg("error", text);
  if (level === "warning") return theme.fg("warning", text);
  return tone(theme, "context", text);
}

export function contextWindow(ctx: ExtensionContext, state: StatusLineState): number {
  // `||`, not `??`: an unknown routed window (0/undefined) falls back to the selection.
  return (ctx.model?.api === "pi-virtual" ? state.responseModel?.contextWindow : undefined) ||
    ctx.model?.contextWindow || 0;
}

function modelName(model: { name?: string; id?: string } | undefined): string {
  let name = sanitizeSingleLine(model?.name ?? model?.id ?? "no-model");
  if (name.startsWith("Claude ")) name = name.slice("Claude ".length);
  return truncateToWidth(name, 28, "…");
}

function buildLeftSegments(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  state: StatusLineState,
  nerdIcons: boolean,
  availableWidth: number,
  scrollIndicator: string | undefined,
): StatusSegment[] {
  const statusSegments = Array.from(state.footerData?.getExtensionStatuses().entries() ?? [])
    .filter(
      ([key]) => key !== LEGACY_SESSION_NAME_STATUS_KEY && key !== LEGACY_TPS_STATUS_KEY,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, status]) => {
      const content = truncateToWidth(sanitizeStatusText(status), 28, "…");
      return content ? [{ id: `status:${key}`, content: `${content}${RESET_ALL}` }] : [];
    });
  const segments: StatusSegment[] = [
    { id: "pi", content: tone(theme, "pi", theme.bold("π")) },
  ];
  if (scrollIndicator) {
    segments.push({ id: "scroll", content: theme.fg("warning", scrollIndicator) });
  }
  segments.push({
    id: "model",
    content: tone(theme, "model", withIcon("◉", modelName(ctx.model))),
  });

  if (ctx.model?.reasoning) {
    const thinking = pi.getThinkingLevel();
    if (thinking !== "off") {
      const color = THINKING_COLORS[thinking] ?? "thinkingText";
      segments.push({ id: "thinking", content: theme.fg(color, withIcon("●", thinking)) });
    }
  }

  const response = ctx.model?.api === "pi-virtual" ? state.responseModel : undefined;
  if (response) {
    const thinking = response.thinkingLevel ? ` ● ${response.thinkingLevel}` : "";
    segments.push({ id: "model", content: tone(theme, "model", `→ ${modelName(response)}${thinking}`) });
  }
  const fastModel = response ?? ctx.model;
  if (isCodexFastModeRequested(fastModel?.provider, fastModel?.id)) {
    segments.push({ id: "fast", content: tone(theme, "fast", withIcon("●", "fast requested")) });
  }

  const pathWidth = Math.max(12, Math.min(40, Math.floor(availableWidth * 0.3)));
  const cwd = truncatePath(
    sanitizeSingleLine(formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE)),
    pathWidth,
  );
  segments.push({
    id: "path",
    content: tone(theme, "path", withIcon(nerdIcons ? "" : "", cwd)),
  });

  const branch = sanitizeSingleLine(state.footerData?.getGitBranch() ?? "");
  if (branch) {
    const branchText = truncateToWidth(branch, 24, "…");
    const { staged, unstaged, untracked } = state.gitStatus.counts;
    const isDirty = staged > 0 || unstaged > 0 || untracked > 0;
    const gitParts = [
      tone(
        theme,
        isDirty || state.gitStatus.status !== "fresh" ? "gitDirty" : "gitClean",
        withIcon(
          nerdIcons ? GIT_BRANCH_ICON_NERD : GIT_BRANCH_ICON_FALLBACK,
          branchText,
        ),
      ),
    ];
    if (unstaged > 0) gitParts.push(theme.fg("warning", `*${unstaged}`));
    if (staged > 0) gitParts.push(theme.fg("success", `+${staged}`));
    if (untracked > 0) gitParts.push(theme.fg("muted", `?${untracked}`));
    if (state.gitStatus.status !== "fresh") gitParts.push(theme.fg("warning", state.gitStatus.status));
    segments.push({ id: "git", content: gitParts.join(" ") });
  }

  segments.push(...statusSegments);
  segments.push({
    id: "context",
    content: contextSegment(
      contextWindow(ctx, state),
      state.compactionReserveTokens,
      theme,
      state.contextEstimate,
      state.loadedContextTokens,
      state.contextUsageInvalidated,
      state.contextUsageSnapshot,
      nerdIcons,
    ),
  });

  if (state.latestTps !== undefined) {
    // Observed request throughput (output tokens / request-to-completion time,
    // including TTFT), not server decode speed. See throughput.ts.
    const icon = nerdIcons ? TPS_ICON_NERD : TPS_ICON_FALLBACK;
    segments.push({
      id: "tps",
      content: tone(theme, "tps", withIcon(icon, `${state.latestTps.toFixed(1)} tps`)),
    });
  }
  if (state.latestTtftMs !== undefined) {
    segments.push({
      id: "ttft",
      content: tone(theme, "tps", withIcon(
        nerdIcons ? TTFT_ICON_NERD : TTFT_ICON_FALLBACK,
        formatFirstTokenLatency(state.latestTtftMs),
      )),
    });
  }

  return segments;
}

export function currentAgentTitle(pi: ExtensionAPI): string | undefined {
  const sessionName = pi.getSessionName();
  return sessionName === undefined ? undefined : normalizeAgentTitle(sessionName);
}

export function truncateSessionTitle(
  agentTitle: string | undefined,
  width: number,
): string {
  return width <= 0 ? "" : truncateToWidth(agentTitle ?? "", width, "…");
}

export function renderTopBorder(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusLineState,
  scrollIndicator: string | undefined,
  agentTitle: string | undefined,
  border: (text: string) => string,
  width: number,
): string {
  const theme = ctx.ui.theme;

  if (width <= 0) return "";
  if (width === 1) return border("─");
  if (width < 10) return border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);

  const edgeWidth = 6;
  const availableWidth = width - edgeWidth;
  const nerdIcons = supportsNerdIcons();
  const leftSegments = buildLeftSegments(
    pi,
    ctx,
    theme,
    state,
    nerdIcons,
    availableWidth,
    scrollIndicator,
  );
  const maxTitleWidth = Math.max(1, Math.min(60, availableWidth - 2));
  const rightSegments: StatusSegment[] = agentTitle
    ? [
        {
          id: "title",
          content: sessionAccent(
            theme,
            agentTitle,
            theme.bold(truncateSessionTitle(agentTitle, maxTitleWidth)),
          ),
        },
      ]
    : [];

  let left = renderStatusGroup(leftSegments, "left", theme, nerdIcons);
  const right = renderStatusGroup(rightSegments, "right", theme, nerdIcons);

  // Keep the title visible while dropping lower-priority details. Subtract the
  // removed segment/separator widths instead of rebuilding and measuring the
  // entire styled line after every removal (especially costly in narrow panes),
  // then re-measure once: separator glyphs may be wider than the assumed column.
  let leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  while (leftWidth + rightWidth > availableWidth && leftSegments.length > 1) {
    while (leftWidth + rightWidth > availableWidth && leftSegments.length > 1) {
      const index = leastImportantSegmentIndex(leftSegments);
      // Both powerline and fallback separators occupy one column plus two spaces.
      leftWidth -= visibleWidth(leftSegments[index]!.content) + 3;
      leftSegments.splice(index, 1);
    }
    left = renderStatusGroup(leftSegments, "left", theme, nerdIcons);
    leftWidth = visibleWidth(left);
  }
  if (leftWidth + rightWidth > availableWidth && leftSegments.length === 1) {
    const groupChromeWidth = 2;
    const leftBudget = Math.max(0, availableWidth - rightWidth);
    if (leftBudget > groupChromeWidth) {
      leftSegments[0] = {
        ...leftSegments[0]!,
        content: truncateToWidth(
          leftSegments[0]!.content,
          leftBudget - groupChromeWidth,
          "…",
        ),
      };
      left = renderStatusGroup(leftSegments, "left", theme, nerdIcons);
      leftWidth = visibleWidth(left);
    } else {
      left = "";
      leftWidth = 0;
    }
  }
  if (leftWidth + rightWidth > availableWidth) {
    left = "";
    leftWidth = 0;
  }

  const gapWidth = Math.max(0, availableWidth - leftWidth - rightWidth);
  return `${border("╭──")}${left}${border("─".repeat(gapWidth))}${right}${border("──╮")}`;
}

export function updatePrimeAgentWidget(pi: ExtensionAPI, state: StatusLineState): void {
  const ctx = state.primeAgentContext;
  if (!ctx) return;

  const nerdIcons = supportsNerdIcons();
  const segments = buildLeftSegments(pi, ctx, ctx.ui.theme, state, nerdIcons, 160, undefined);
  const agentTitle = currentAgentTitle(pi);
  if (agentTitle) {
    segments.push({
      id: "title",
      content: sessionAccent(
        ctx.ui.theme,
        agentTitle,
        ctx.ui.theme.bold(agentTitle),
      ),
    });
  }
  // Prime Agent widgets are plain strings without a render width. Pi's Text
  // wrapper would wrap (not clip) them; clip to the terminal when it is known.
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  const fullText = renderStatusGroup(segments, "left", ctx.ui.theme, nerdIcons);
  const text = columns && columns > 2 ? truncateToWidth(fullText, columns - 2, "…") : fullText;
  if (text === state.primeAgentWidgetText) return;

  state.primeAgentWidgetText = text;
  // Prime Agent's daemon protocol cannot carry custom footer/editor factories,
  // but it does support serializable widgets. Place the same status information
  // directly below the editor as its daemon-safe footer.
  ctx.ui.setWidget(PRIME_AGENT_WIDGET_KEY, [text], { placement: "belowEditor" });
}
