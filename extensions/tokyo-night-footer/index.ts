import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getCurrentSystemMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  firstUserPrompt,
  generateAgentTitle,
  normalizeAgentTitle,
} from "./agent-title.ts";
import { isCodexFastModeRequested } from "./codex-fast-mode.ts";
import {
  createGitStatusTracker,
  disposeGitStatus,
  ensureGitStatus,
  type GitStatusTracker,
  invalidateGitStatus,
} from "./git-status.ts";
import {
  assistantMatchesModel,
  type ContextTokenEstimate,
  estimateContextWithMessage,
  estimateLoadedContextTokens,
  estimateProjectedContext,
  estimateRequestContextTokens,
  estimateStreamingContextTokens,
  estimateSystemContextTokens,
  isCompletedResponse,
  usageInputTokens,
  usageTokenTotal,
} from "./context-usage.ts";
import {
  formatFirstTokenLatency,
  responseTimeToFirstToken,
  responseTokensPerSecond,
} from "./throughput.ts";

// Visual layout adapted from oh-my-pi's MIT-licensed editor status line.
const LEGACY_SESSION_NAME_STATUS_KEY = "ventris-session-name";
const LEGACY_TPS_STATUS_KEY = "ventris-tps";
const PERMISSION_STATUS_KEY = "pi-permission-system";
const PRIME_AGENT_WIDGET_KEY = "tokyo-night-footer";
const TITLE_GENERATION_TIMEOUT_MS = 20_000;
const TPS_ICON_NERD = "󰓅";
const TPS_ICON_FALLBACK = "⚡";
const TTFT_ICON_NERD = "";
const TTFT_ICON_FALLBACK = "◷";
const CONTEXT_ICON_NERD = "";
const CONTEXT_ICON_FALLBACK = "◫";
const GIT_BRANCH_ICON_NERD = "";
const GIT_BRANCH_ICON_FALLBACK = "⎇";
const TOKYO_NIGHT_ULTRAVIOLET = "#bb9af7";
const TOKYO_NIGHT_BACKGROUND = "#1a1b26";
const RESET_ALL = "\x1b[0m";
const RESET_FOREGROUND = "\x1b[39m";
const TOKYO_NIGHT_SESSION_ACCENTS = [
  "#f7768e",
  "#ff9e64",
  "#e0af68",
  "#9ece6a",
  "#73daca",
] as const;

type StatusTone =
  | "pi"
  | "model"
  | "fast"
  | "path"
  | "gitClean"
  | "gitDirty"
  | "context"
  | "tps"
  | "separator";

const TOKYO_NIGHT_TONES: Record<StatusTone, string> = {
  pi: "#7dcfff",
  model: "#bb9af7",
  fast: "#7dcfff",
  path: "#7dcfff",
  gitClean: "#bb9af7",
  gitDirty: "#e0af68",
  context: "#9ece6a",
  tps: "#73daca",
  separator: "#51597d",
};

const SEMANTIC_TONES: Record<StatusTone, ThemeColor> = {
  pi: "borderAccent",
  model: "customMessageLabel",
  fast: "accent",
  path: "borderAccent",
  gitClean: "success",
  gitDirty: "warning",
  context: "success",
  tps: "success",
  separator: "dim",
};

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

interface StatusLineState {
  latestTps: number | undefined;
  latestTtftMs: number | undefined;
  contextEstimate: ContextTokenEstimate | undefined;
  responseModel: { provider: string; id: string; name: string; contextWindow: number; thinkingLevel?: string } | undefined;
  requestContextEstimate: ContextTokenEstimate | undefined;
  loadedContextTokens: number | undefined;
  authoritativeLoadedContextTokens: number | undefined;
  streamingContextChars: number;
  streamingContentChars: Map<number, number>;
  contextUsageInvalidated: boolean;
  contextUsageSnapshot: number | null | undefined;
  checkContextEntries: (() => void) | undefined;
  footerData: ReadonlyFooterDataProvider | undefined;
  gitStatus: GitStatusTracker;
  runtimeContext: ExtensionContext | undefined;
  primeAgentContext: ExtensionContext | undefined;
  primeAgentWidgetText: string | undefined;
  runtimeActive: boolean;
  runtimeGeneration: number;
  titleGenerationAbortController: AbortController;
  titleGenerationInFlight: boolean;
}

function sanitizeSingleLine(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function sanitizeStatusText(text: string): string {
  // Extension statuses may contain ANSI styling, so remove only layout-breaking whitespace.
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
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

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
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

function truncatePath(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…";

  const tail = Array.from(text);
  while (tail.length > 0 && visibleWidth(tail.join("")) > width - 1) tail.shift();
  return `…${tail.join("")}`;
}

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

function ansiColor(hex: string, channel: 38 | 48): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `\x1b[${channel};2;${red};${green};${blue}m`;
}

function ansiForeground(hex: string): string {
  return ansiColor(hex, 38);
}

function usesExactTokyoNight(theme: Theme): boolean {
  return theme.name === "tokyo-night" && theme.getColorMode() === "truecolor";
}

function tone(theme: Theme, statusTone: StatusTone, text: string): string {
  if (usesExactTokyoNight(theme)) {
    return `${ansiForeground(TOKYO_NIGHT_TONES[statusTone])}${text}${RESET_FOREGROUND}`;
  }
  return theme.fg(SEMANTIC_TONES[statusTone], text);
}

function styleCaret(line: string, theme: Theme): string {
  if (!line.includes("\x1b[7m")) return line;

  if (!usesExactTokyoNight(theme)) {
    const accent = theme.getFgAnsi("customMessageLabel");
    return line.replace(
      /\x1b\[7m([\s\S]*?)\x1b\[0m/g,
      (_match, glyph: string) => `${accent}\x1b[7m${glyph}${RESET_ALL}`,
    );
  }

  const background = ansiColor(TOKYO_NIGHT_ULTRAVIOLET, 48);
  const foreground = ansiForeground(TOKYO_NIGHT_BACKGROUND);
  return line.replace(
    /\x1b\[7m([\s\S]*?)\x1b\[0m/g,
    (_match, glyph: string) => `${background}${foreground}${glyph}${RESET_ALL}`,
  );
}

function sessionAccentHex(name: string): string {
  let hash = 5381;
  for (let index = 0; index < name.length; index++) {
    hash = (((hash << 5) + hash) ^ name.charCodeAt(index)) >>> 0;
  }
  return TOKYO_NIGHT_SESSION_ACCENTS[hash % TOKYO_NIGHT_SESSION_ACCENTS.length]!;
}

function sessionAccent(theme: Theme, name: string, text: string): string {
  if (usesExactTokyoNight(theme)) {
    return `${ansiForeground(sessionAccentHex(name))}${text}${RESET_FOREGROUND}`;
  }
  return theme.fg("borderAccent", text);
}

function statusSegmentPriority(id: string): number {
  if (id === `status:${PERMISSION_STATUS_KEY}`) return 100;
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

function estimateLoadedContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  systemPromptOverride?: string,
): number | undefined {
  const compatContext = ctx as { getSystemPrompt?: () => string };
  const systemPrompt = systemPromptOverride ?? compatContext.getSystemPrompt?.();
  if (systemPrompt === undefined) return undefined;

  const compatPi = pi as {
    getActiveTools?: ExtensionAPI["getActiveTools"];
    getAllTools?: ExtensionAPI["getAllTools"];
  };
  return estimateLoadedContextTokens(
    systemPrompt,
    compatPi.getAllTools?.() ?? [],
    compatPi.getActiveTools?.() ?? [],
  );
}

function contextSegment(
  contextWindow: number,
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
  const percent =
    contextTokens !== null && contextTokens !== undefined && contextWindow > 0
      ? (contextTokens / contextWindow) * 100
      : 0;
  const display =
    contextWindow <= 0
      ? "?/?"
      : contextTokens === null || contextTokens === undefined
        ? `?/${formatTokens(contextWindow)}`
        : `${isEstimate ? "~" : ""}${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`;
  const text = withIcon(nerdIcons ? CONTEXT_ICON_NERD : CONTEXT_ICON_FALLBACK, display);

  if (percent > 90) return theme.fg("error", text);
  if (percent > 70) return theme.fg("warning", text);
  return tone(theme, "context", text);
}

function contextWindow(ctx: ExtensionContext, state: StatusLineState): number {
  return (ctx.model?.api === "pi-virtual" ? state.responseModel?.contextWindow : undefined) ??
    ctx.model?.contextWindow ?? 0;
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
  state.checkContextEntries?.();
  const statusSegments = Array.from(state.footerData?.getExtensionStatuses().entries() ?? [])
    .filter(
      ([key]) => key !== LEGACY_SESSION_NAME_STATUS_KEY && key !== LEGACY_TPS_STATUS_KEY,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, status]) => {
      const content = truncateToWidth(sanitizeStatusText(status), 28, "…");
      return content ? [{ id: `status:${key}`, content: `${content}${RESET_ALL}` }] : [];
    });
  const criticalStatuses = statusSegments.filter(
    (segment) => segment.id === `status:${PERMISSION_STATUS_KEY}`,
  );
  const otherStatuses = statusSegments.filter(
    (segment) => segment.id !== `status:${PERMISSION_STATUS_KEY}`,
  );
  const segments: StatusSegment[] = [
    { id: "pi", content: tone(theme, "pi", theme.bold("π")) },
    ...criticalStatuses,
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

  segments.push(...otherStatuses);
  segments.push({
    id: "context",
    content: contextSegment(
      contextWindow(ctx, state),
      theme,
      state.contextEstimate,
      state.loadedContextTokens,
      state.contextUsageInvalidated,
      state.contextUsageSnapshot,
      nerdIcons,
    ),
  });

  if (state.latestTps !== undefined) {
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

function currentAgentTitle(pi: ExtensionAPI): string | undefined {
  const sessionName = pi.getSessionName();
  return sessionName === undefined ? undefined : normalizeAgentTitle(sessionName);
}

export function truncateSessionTitle(
  agentTitle: string | undefined,
  width: number,
): string {
  return width <= 0 ? "" : truncateToWidth(agentTitle ?? "", width, "…");
}

function renderTopBorder(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatusLineState,
  scrollIndicator: string | undefined,
  fallbackBorder: (text: string) => string,
  width: number,
): string {
  const theme = ctx.ui.theme;
  const agentTitle = currentAgentTitle(pi);
  const border = agentTitle
    ? (text: string) => sessionAccent(theme, agentTitle, text)
    : fallbackBorder;

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
  // entire styled line after every removal (especially costly in narrow panes).
  let leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const initialSegmentCount = leftSegments.length;
  while (leftWidth + rightWidth > availableWidth && leftSegments.length > 1) {
    const index = leastImportantSegmentIndex(leftSegments);
    // Both powerline and fallback separators occupy one column plus two spaces.
    leftWidth -= visibleWidth(leftSegments[index]!.content) + 3;
    leftSegments.splice(index, 1);
  }
  if (leftSegments.length !== initialSegmentCount) {
    left = renderStatusGroup(leftSegments, "left", theme, nerdIcons);
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

function updatePrimeAgentWidget(pi: ExtensionAPI, state: StatusLineState): void {
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
  const text = renderStatusGroup(segments, "left", ctx.ui.theme, nerdIcons);
  if (text === state.primeAgentWidgetText) return;

  state.primeAgentWidgetText = text;
  // Prime Agent's daemon protocol cannot carry custom footer/editor factories,
  // but it does support serializable widgets. Place the same status information
  // directly below the editor as its daemon-safe footer.
  ctx.ui.setWidget(PRIME_AGENT_WIDGET_KEY, [text], { placement: "belowEditor" });
}

function findBottomBorderIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index > 0; index--) {
    const plain = stripVTControlCharacters(lines[index]!);
    if (/^─+$/.test(plain) || /^───\s+↓\s+\d+\s+more\s+─*$/.test(plain)) return index;
  }
  return -1;
}

class EmptyFooter implements Component {
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

class TokyoNightStatusEditor extends CustomEditor {
  #pi: ExtensionAPI;
  #ctx: ExtensionContext;
  #state: StatusLineState;
  #refreshGitStatus: () => void;
  #removedBorderRow: number | undefined;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    state: StatusLineState,
    refreshGitStatus: () => void,
    onReady: (requestRender: () => void) => void,
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
    this.#pi = pi;
    this.#ctx = ctx;
    this.#state = state;
    this.#refreshGitStatus = refreshGitStatus;
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

  render(width: number): string[] {
    this.#removedBorderRow = undefined;
    this.#refreshGitStatus();
    const agentTitle = currentAgentTitle(this.#pi);
    this.borderColor = agentTitle
      ? (text: string) =>
          sessionAccent(this.#ctx.ui.theme, agentTitle, text)
      : (text: string) => this.#ctx.ui.theme.fg("border", text);

    if (width < 8) return super.render(width);

    const lines = super.render(width - 6);
    if (lines.length === 0) return lines;
    const bottomBorderIndex = findBottomBorderIndex(lines);
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

export default function (pi: ExtensionAPI): void {
  const state: StatusLineState = {
    latestTps: undefined,
    latestTtftMs: undefined,
    contextEstimate: undefined,
    responseModel: undefined,
    requestContextEstimate: undefined,
    loadedContextTokens: undefined,
    authoritativeLoadedContextTokens: undefined,
    streamingContextChars: 0,
    streamingContentChars: new Map(),
    contextUsageInvalidated: false,
    contextUsageSnapshot: undefined,
    checkContextEntries: undefined,
    footerData: undefined,
    gitStatus: createGitStatusTracker(process.cwd()),
    runtimeContext: undefined,
    primeAgentContext: undefined,
    primeAgentWidgetText: undefined,
    runtimeActive: false,
    runtimeGeneration: 0,
    titleGenerationAbortController: new AbortController(),
    titleGenerationInFlight: false,
  };
  let requestRender: (() => void) | undefined;
  let requestStartedAt: number | undefined;
  let requestFirstTokenAt: number | undefined;
  let requestHeadersObserved = false;
  let requestClockLocked = false;
  let requestLoadedContextTokens: number | undefined;
  let registeredLoadedContextTokens: number | undefined;
  let runSystemPromptOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;
  let provenUsage: AssistantMessage | undefined;
  let usageLoadedContextTokens: number | undefined;
  let requestSystemPromptOverride: string | undefined;
  let contextLeafId: string | null | undefined;
  let projectionLeafId: string | null | undefined;
  let contextRefreshQueued = false;
  let contextRevision = 0;
  let requestContextRevision = 0;
  const bashRefreshTimers = new Set<ReturnType<typeof setTimeout>>();

  const recordResponseModel = (ctx: ExtensionContext, message: AssistantMessage): void => {
    if (!isCompletedResponse(message.stopReason) || message.api === "pi-virtual") return;
    const model = ctx.modelRegistry?.find(message.provider, message.model);
    state.responseModel = {
      provider: message.provider, id: message.model, name: model?.name ?? message.model,
      contextWindow: model?.contextWindow ?? 0, thinkingLevel: message.thinkingLevel,
    };
  };

  const contextModel = (ctx: ExtensionContext) =>
    ctx.model?.api === "pi-virtual" ? state.responseModel : ctx.model;

  const rebuildProjectedContext = (ctx: ExtensionContext): boolean => {
    // Prime Agent's older transport lacks projection; keep its existing fallback.
    if (!ctx.sessionManager.buildSessionProjection) return false;
    const projection = ctx.sessionManager.buildSessionProjection();
    projectionLeafId = ctx.sessionManager.getLeafId();
    const branch = ctx.sessionManager.getBranch();
    state.responseModel = undefined;
    for (let index = projection.messages.length - 1; index >= 0; index--) {
      const message = projection.messages[index]!;
      if (message.role === "assistant" && isCompletedResponse(message.stopReason) && message.api !== "pi-virtual") {
        recordResponseModel(ctx, message);
        break;
      }
    }
    const model = contextModel(ctx);
    const result = estimateProjectedContext(projection, branch, state.loadedContextTokens ?? 0, {
      provider: model?.provider, id: model?.id,
    }, state.authoritativeLoadedContextTokens);
    state.loadedContextTokens = result.loadedContextTokens;
    provenUsage = result.provenUsage;
    usageLoadedContextTokens = result.usageLoadedContextTokens;
    state.contextUsageInvalidated = result.invalidated;
    state.contextUsageSnapshot = undefined;
    if (result.invalidated) state.authoritativeLoadedContextTokens = undefined;
    state.contextEstimate = result.estimate;
    return true;
  };

  const snapshotContextUsage = (ctx: ExtensionContext): void => {
    if (rebuildProjectedContext(ctx)) return;
    const tokens = ctx.getContextUsage()?.tokens;
    state.contextUsageSnapshot = tokens;
    if (tokens === null || tokens === undefined || tokens === 0) return;
    // Pi's own usage fallback does not validate the active model identity.
    const manager = ctx.sessionManager;
    // Current Pi can walk just the trailing entries through O(1) lookups. Avoid
    // a second full getBranch() allocation; retain the older runtime fallback.
    const getLeafEntry = (manager as {
      getLeafEntry?: ExtensionContext["sessionManager"]["getLeafEntry"];
    }).getLeafEntry;
    const branch = getLeafEntry ? undefined : manager.getBranch();
    let index = (branch?.length ?? 0) - 1;
    let entry = branch ? branch[index] : getLeafEntry?.call(manager);
    let excludedTokens = 0;
    while (entry) {
      // Pi's fallback estimator includes trailing persisted !! results even
      // though convertToLlm excludes them. Correct that on resume/tree/reload.
      if (entry.type === "message" && entry.message.role === "bashExecution" && entry.message.excludeFromContext) {
        excludedTokens += Math.ceil((entry.message.command.length + entry.message.output.length) / 4);
      }
      if (entry.type === "message" && entry.message.role === "assistant" &&
          isCompletedResponse(entry.message.stopReason) && usageInputTokens(entry.message.usage) > 0) {
        recordResponseModel(ctx, entry.message);
        const model = contextModel(ctx);
        if (!assistantMatchesModel(entry.message, { provider: model?.provider, id: model?.id })) {
          state.contextUsageSnapshot = undefined;
        }
        break;
      }
      entry = branch ? branch[--index] : entry.parentId === null ? undefined : manager.getEntry(entry.parentId);
    }
    if (state.contextUsageSnapshot !== undefined) {
      state.contextUsageSnapshot = Math.max(0, tokens - excludedTokens);
    }
  };

  const contextRenderKey = (estimate: ContextTokenEstimate | undefined): string => {
    if (!estimate) return "unknown";
    const window = state.runtimeContext ? contextWindow(state.runtimeContext, state) : 0;
    const percent = window > 0 ? (estimate.tokens / window) * 100 : 0;
    const level = percent > 90 ? "error" : percent > 70 ? "warning" : "normal";
    return `${estimate.estimated ? "estimated" : "reported"}:${formatTokens(estimate.tokens)}:${level}`;
  };

  const setContextEstimate = (estimate: ContextTokenEstimate | undefined): void => {
    const previousKey = contextRenderKey(state.contextEstimate);
    state.contextEstimate = estimate;
    if (contextRenderKey(estimate) !== previousKey) requestRender?.();
  };

  const resetCompactedContext = (): void => {
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    requestStartedAt = undefined;
    requestFirstTokenAt = undefined;
    requestLoadedContextTokens = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
  };

  const refreshContextEntries = (ctx: ExtensionContext): void => {
    const leafId = ctx.sessionManager.getLeafId?.();
    if (leafId === undefined || leafId === contextLeafId) return;
    let entry = leafId === null ? undefined : ctx.sessionManager.getEntry(leafId);
    let estimate = state.contextEstimate;
    if (!estimate && !state.contextUsageInvalidated && state.contextUsageSnapshot !== null) {
      const tokens = state.contextUsageSnapshot === 0
        ? state.loadedContextTokens
        : state.contextUsageSnapshot;
      if (tokens !== undefined) estimate = { tokens, estimated: true };
    }
    let changed = false;
    let contextEdited = false;
    let compacted = false;
    let systemChanged = false;
    // Inspect only newly appended entries, outside render/streaming. Boundary
    // compactions emit entry_appended, not the extension's session_compact event.
    while (entry && entry.id !== contextLeafId) {
      if (entry.type === "context_edit") contextEdited = true;
      if (entry.type === "compaction") compacted = true;
      if (entry.type === "message" && entry.message.role === "system") systemChanged = true;
      if (estimate && entry.type === "message" && entry.message.role === "bashExecution") {
        const next = estimateContextWithMessage(estimate, entry.message);
        changed ||= next !== estimate;
        estimate = next;
      }
      entry = entry.parentId === null ? undefined : ctx.sessionManager.getEntry(entry.parentId);
    }
    contextLeafId = leafId;
    if (contextEdited || compacted) contextRevision++;
    if (compacted) resetCompactedContext();
    if (contextEdited || compacted || systemChanged) {
      if (compacted) snapshotContextUsage(ctx);
      else rebuildProjectedContext(ctx);
      if (state.requestContextEstimate) state.requestContextEstimate = state.contextEstimate;
      requestRender?.();
    } else if (changed) setContextEstimate(estimate);
  };

  const checkContextEntries = (): void => {
    const ctx = state.runtimeContext;
    // Prime Agent may not expose leaf lookup. In Pi these are O(1) map accesses.
    if (!ctx?.sessionManager.getLeafId || contextRefreshQueued || !state.runtimeActive) return;
    if (ctx.sessionManager.getLeafId() === contextLeafId) return;
    contextRefreshQueued = true;
    const generation = state.runtimeGeneration;
    queueMicrotask(() => {
      contextRefreshQueued = false;
      if (!state.runtimeActive || generation !== state.runtimeGeneration) return;
      refreshContextEntries(ctx);
    });
  };

  const updateLoadedContext = (loadedContextTokens: number | undefined): void => {
    const previous = state.loadedContextTokens;
    state.loadedContextTokens = loadedContextTokens;
    if (
      previous === undefined ||
      loadedContextTokens === undefined ||
      previous === loadedContextTokens
    ) {
      return;
    }

    const delta = loadedContextTokens - previous;
    if (state.requestContextEstimate) {
      state.requestContextEstimate = {
        tokens: Math.max(0, state.requestContextEstimate.tokens + delta),
        estimated: true,
      };
    }
    if (state.contextEstimate) {
      setContextEstimate({
        tokens: Math.max(0, state.contextEstimate.tokens + delta),
        estimated: true,
      });
    }
  };

  const refreshLoadedContext = (ctx: ExtensionContext): void => {
    const registered = estimateLoadedContext(pi, ctx);
    // Registration metadata is a forecast for unsent changes, not a replacement
    // for canonical prepareLoadout descriptions or a request-local system state.
    if (registered !== undefined && registeredLoadedContextTokens !== undefined) {
      updateLoadedContext(Math.max(0, (state.loadedContextTokens ?? registeredLoadedContextTokens) +
        registered - registeredLoadedContextTokens));
    } else if (state.loadedContextTokens === undefined) updateLoadedContext(registered);
    registeredLoadedContextTokens = registered;
  };

  const refreshGitStatus = (force = false) => {
    if (!state.runtimeActive) return;
    const tracker = state.gitStatus;
    if (force) invalidateGitStatus(tracker);
    ensureGitStatus(pi, tracker, () => {
      if (state.gitStatus === tracker) requestRender?.();
    });
  };

  const maybeGenerateAgentTitle = (
    ctx: ExtensionContext,
    submittedPrompt?: string,
  ): void => {
    if (!state.runtimeActive || state.titleGenerationInFlight || pi.getSessionName()) return;

    const prompt =
      (submittedPrompt === undefined ? undefined : normalizeAgentTitle(submittedPrompt)) ??
      firstUserPrompt(ctx.sessionManager.getBranch());
    const model = ctx.model;
    if (!prompt || !model) return;

    const runtimeGeneration = state.runtimeGeneration;
    const signal = AbortSignal.any([
      state.titleGenerationAbortController.signal,
      AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
    ]);
    state.titleGenerationInFlight = true;

    void generateAgentTitle(ctx.modelRegistry, model, prompt, signal)
      .then((title) => {
        if (
          !title ||
          signal.aborted ||
          !state.runtimeActive ||
          state.runtimeGeneration !== runtimeGeneration
        ) {
          return;
        }
        if (!pi.getSessionName()) pi.setSessionName(title);
      })
      .catch(() => {
        // Title generation is best-effort; leave the session unnamed so a later
        // submitted prompt can retry.
      })
      .finally(() => {
        if (state.runtimeGeneration === runtimeGeneration) {
          state.titleGenerationInFlight = false;
        }
      });
  };

  pi.on("session_start", (_event, ctx) => {
    // Prime Agent 0.7 predates ctx.mode. Current Pi uses it to distinguish the
    // TUI from other UI-capable transports such as RPC.
    const mode = (ctx as { mode?: string }).mode;
    if (mode === undefined ? !ctx.hasUI : mode !== "tui") return;

    disposeGitStatus(state.gitStatus);
    for (const timer of bashRefreshTimers) clearTimeout(timer);
    bashRefreshTimers.clear();
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
    state.responseModel = undefined;
    state.loadedContextTokens = estimateLoadedContext(pi, ctx);
    registeredLoadedContextTokens = state.loadedContextTokens;
    runSystemPromptOptions = undefined;
    provenUsage = undefined;
    usageLoadedContextTokens = undefined;
    requestSystemPromptOverride = undefined;
    snapshotContextUsage(ctx);
    contextLeafId = ctx.sessionManager.getLeafId?.();
    state.checkContextEntries = checkContextEntries;
    state.footerData = undefined;
    state.gitStatus = createGitStatusTracker(ctx.cwd);
    state.runtimeContext = ctx;
    state.primeAgentContext = undefined;
    state.primeAgentWidgetText = undefined;
    state.runtimeActive = true;
    state.runtimeGeneration++;
    state.titleGenerationAbortController.abort();
    state.titleGenerationAbortController = new AbortController();
    state.titleGenerationInFlight = false;
    requestRender = undefined;
    requestStartedAt = undefined;
    ctx.ui.setStatus(LEGACY_SESSION_NAME_STATUS_KEY, undefined);
    ctx.ui.setStatus(LEGACY_TPS_STATUS_KEY, undefined);

    if (mode === undefined) {
      state.primeAgentContext = ctx;
      requestRender = () => updatePrimeAgentWidget(pi, state);
      requestRender();
      refreshGitStatus(true);
      maybeGenerateAgentTitle(ctx);
      return;
    }

    ctx.ui.setFooter((tui, _theme, footerData) => {
      const render = () => tui.requestRender();
      const branchChanged = () => {
        refreshGitStatus(true);
        render();
      };
      requestRender = render;
      state.footerData = footerData;
      const unsubscribe = footerData.onBranchChange(branchChanged);

      return new EmptyFooter(() => {
        unsubscribe();
        if (state.footerData === footerData) state.footerData = undefined;
        if (requestRender === render) requestRender = undefined;
      });
    });

    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
      new TokyoNightStatusEditor(
        tui,
        editorTheme,
        keybindings,
        pi,
        ctx,
        state,
        () => refreshGitStatus(),
        (render) => {
          requestRender = render;
        },
      ),
    );
    maybeGenerateAgentTitle(ctx);
  });

  pi.on("resources_discover", (_event, ctx) => {
    if (!state.runtimeActive) return;
    // Resource discovery can change the active tool loadout after startup.
    refreshLoadedContext(ctx);
    requestRender?.();
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Pi shares this options object across all before_agent_start handlers.
    // Retain the reference so later handlers (including returned systemPrompt)
    // can set or clear an explicit override even when its text is unchanged.
    if (state.runtimeActive) runSystemPromptOptions = event.systemPromptOptions;
    maybeGenerateAgentTitle(ctx, event.prompt);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!state.runtimeActive) return;
    // This runs after every extension's before_agent_start handler, so both the
    // effective system prompt and active tool schemas match the agent request.
    refreshLoadedContext(ctx);
    requestRender?.();
  });

  pi.on("context", (event, ctx) => {
    if (!state.runtimeActive) return;
    // Request boundaries may walk canonical history; rendering never does.
    refreshContextEntries(ctx);
    if (ctx.sessionManager.getLeafId?.() !== projectionLeafId) rebuildProjectedContext(ctx);
    requestContextRevision = contextRevision;
    // This request already contains every persisted shell result before it.
    contextLeafId = ctx.sessionManager.getLeafId?.();
    // Old runtimes without request/header hooks retain the context fallback.
    requestStartedAt = performance.now();
    requestFirstTokenAt = undefined;
    requestHeadersObserved = false;
    requestClockLocked = false;
    requestLoadedContextTokens = undefined;
    // Tools can be activated by a tool result between calls in the same run.
    refreshLoadedContext(ctx);
    const loadedContextTokens = state.loadedContextTokens;
    if (loadedContextTokens === undefined) return;
    requestLoadedContextTokens = loadedContextTokens;
    // All before_agent_start handlers have finished by this request boundary.
    // Pi reapplies an explicit forced prompt after context_with_system, even
    // when that prompt equals the canonical text or is the empty string.
    requestSystemPromptOverride = runSystemPromptOptions?.forceSystemPrompt;

    const model = contextModel(ctx);
    const estimate = estimateRequestContextTokens(
      event.messages,
      loadedContextTokens,
      { provider: model?.provider, id: model?.id },
      state.authoritativeLoadedContextTokens ?? usageLoadedContextTokens,
      !state.contextUsageInvalidated,
      provenUsage,
    );
    state.requestContextEstimate = estimate;
    setContextEstimate(estimate);
  });

  pi.on("context_with_system", (event, ctx) => {
    if (!state.runtimeActive) return;
    let messages = event.messages;
    if (requestSystemPromptOverride !== undefined) {
      const system = getCurrentSystemMessage(messages);
      messages = [{ role: "system", content: requestSystemPromptOverride,
        toolsAdded: system?.toolsAdded, timestamp: system?.timestamp ?? 0 },
      ...messages.filter((message) => message.role !== "system")];
    }
    // This public hook sees prepared declarations and earlier request-local
    // transforms. Pi 1.0.2's hiddenDeclarations projection runs AFTER this hook;
    // its private hidden set and later handlers are not observable here.
    const loaded = estimateSystemContextTokens(messages) ?? 0;
    updateLoadedContext(loaded);
    requestLoadedContextTokens = loaded;
    const model = contextModel(ctx);
    const estimate = estimateRequestContextTokens(messages, loaded,
      { provider: model?.provider, id: model?.id },
      state.authoritativeLoadedContextTokens ?? usageLoadedContextTokens,
      !state.contextUsageInvalidated, provenUsage);
    state.requestContextEstimate = estimate;
    setContextEstimate(estimate);
  });

  pi.on("before_provider_headers", () => {
    // ModelRuntime emits this after resolving auth, even for custom streamSimple
    // providers that omit onPayload. Prefer the later payload hook if available.
    if (state.runtimeActive && requestStartedAt !== undefined && !requestClockLocked && !requestHeadersObserved) {
      requestStartedAt = performance.now();
      requestHeadersObserved = true;
    }
  });

  pi.on("before_provider_request", () => {
    // Do not time unrelated calls (e.g. compaction/title generation). A context
    // event opens a main-agent request; message_end closes it.
    if (state.runtimeActive && requestStartedAt !== undefined && !requestClockLocked) {
      requestStartedAt = performance.now();
      // Repeated payload hooks (transport fallback/retry) belong to the same
      // logical response. Restarting here would hide latency and inflate TPS.
      requestClockLocked = true;
    }
  });

  pi.on("message_start", (event) => {
    if (!state.runtimeActive || event.message.role !== "assistant") return;
    // A late custom-provider hook must not move the start past response headers.
    requestClockLocked = true;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    if (state.requestContextEstimate) {
      setContextEstimate(estimateStreamingContextTokens(state.requestContextEstimate, 0,
        requestContextRevision === contextRevision ? event.message.usage : undefined));
    }
  });

  pi.on("message_update", (event) => {
    if (!state.runtimeActive || event.message.role !== "assistant") return;
    const streamEvent = event.assistantMessageEvent;
    if (
      streamEvent.type === "text_delta" ||
      streamEvent.type === "thinking_delta" ||
      streamEvent.type === "toolcall_delta"
    ) {
      if (requestFirstTokenAt === undefined && requestStartedAt !== undefined && streamEvent.delta.length > 0) {
        // Only immutable delta payloads carry event-time output evidence. Pi's
        // partial.content/usage are shared mutable objects: even a start event
        // can already contain future output when a buffered stream is consumed.
        // One clock read per response, never one per token/chunk or render.
        requestFirstTokenAt = performance.now();
        requestClockLocked = true;
      }
      const previous = state.streamingContentChars.get(streamEvent.contentIndex) ?? 0;
      const current = previous + streamEvent.delta.length;
      state.streamingContentChars.set(streamEvent.contentIndex, current);
      state.streamingContextChars += streamEvent.delta.length;
    } else if (
      streamEvent.type === "text_end" ||
      streamEvent.type === "thinking_end" ||
      streamEvent.type === "toolcall_end"
    ) {
      const previous = state.streamingContentChars.get(streamEvent.contentIndex) ?? 0;
      let current = previous;
      if (streamEvent.type === "text_end" || streamEvent.type === "thinking_end") {
        current = streamEvent.content.length;
      } else {
        try {
          current =
            streamEvent.toolCall.name.length +
            JSON.stringify(streamEvent.toolCall.arguments).length;
        } catch {
          // Keep the streamed character count if unusual tool arguments cannot serialize.
        }
      }
      state.streamingContentChars.set(streamEvent.contentIndex, current);
      state.streamingContextChars = Math.max(
        0,
        state.streamingContextChars + current - previous,
      );
    }

    if (state.requestContextEstimate) {
      setContextEstimate(
        estimateStreamingContextTokens(
          state.requestContextEstimate,
          state.streamingContextChars,
          requestContextRevision === contextRevision ? event.message.usage : undefined,
        ),
      );
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!state.runtimeActive) return;
    if (event.message.role !== "assistant") {
      if (state.contextEstimate) {
        setContextEstimate(estimateContextWithMessage(state.contextEstimate, event.message));
      }
      return;
    }

    const completedAt = performance.now();
    const contextTokens = usageTokenTotal(event.message.usage);
    const completed = isCompletedResponse(event.message.stopReason);
    const matchesModel = ctx.model?.api === "pi-virtual"
      ? event.message.api !== "pi-virtual"
      : assistantMatchesModel(event.message, { provider: ctx.model?.provider, id: ctx.model?.id });
    if (completed && matchesModel) recordResponseModel(ctx, event.message);
    const hasCurrentModelUsage = completed && matchesModel && requestContextRevision === contextRevision &&
      usageInputTokens(event.message.usage) > 0;

    const previousTps = state.latestTps;
    const previousTtftMs = state.latestTtftMs;
    if (completed && matchesModel) {
      state.latestTps = responseTokensPerSecond(event.message, requestStartedAt, completedAt);
      // Publish the pair on completion, retaining the last successful response
      // during streaming/failure. TTFT does not depend on token-usage support.
      state.latestTtftMs = responseTimeToFirstToken(requestStartedAt, requestFirstTokenAt, completedAt);
    }
    if (hasCurrentModelUsage) {
      state.contextUsageInvalidated = false;
      // A tool loadout change while streaming applies to the NEXT request, not
      // the one whose usage just arrived.
      state.authoritativeLoadedContextTokens = requestLoadedContextTokens;
      setContextEstimate({ tokens: contextTokens, estimated: false });
    } else if (state.requestContextEstimate) {
      const fallback = estimateContextWithMessage(state.requestContextEstimate, event.message);
      setContextEstimate(estimateStreamingContextTokens(
        state.requestContextEstimate,
        (fallback.tokens - state.requestContextEstimate.tokens) * 4,
        completed && matchesModel && requestContextRevision === contextRevision ? event.message.usage : undefined,
      ));
    }
    state.requestContextEstimate = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    requestStartedAt = undefined;
    requestFirstTokenAt = undefined;
    // Context/TPS can round to the same display value even when TTFT changes.
    if (ctx.model?.api === "pi-virtual" || state.latestTps !== previousTps || state.latestTtftMs !== previousTtftMs) requestRender?.();
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
      refreshGitStatus(true);
    }
  });

  pi.on("user_bash", () => {
    if (!state.runtimeActive) return;
    const tracker = state.gitStatus;
    for (const delay of [100, 500, 1_500]) {
      const timer = setTimeout(() => {
        bashRefreshTimers.delete(timer);
        if (state.runtimeActive && state.gitStatus === tracker) refreshGitStatus(true);
      }, delay);
      bashRefreshTimers.add(timer);
    }
  });

  pi.on("turn_end", () => {
    requestStartedAt = undefined;
    refreshGitStatus(true);
  });
  pi.on("agent_settled", (_event, ctx) => {
    // Boundary handlers/recovery can append context edits/compactions after the last turn
    // notification, including when there will be no further model request.
    checkContextEntries();
    maybeGenerateAgentTitle(ctx);
    requestRender?.();
  });
  pi.on("session_info_changed", () => requestRender?.());
  pi.on("model_select", (_event, ctx) => {
    if (!state.runtimeActive) return;
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    requestStartedAt = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = true;
    if (ctx.model?.api === "pi-virtual") snapshotContextUsage(ctx);
    requestRender?.();
  });
  pi.on("thinking_level_select", () => requestRender?.());
  pi.on("session_compact", (_event, ctx) => {
    if (!state.runtimeActive) return;
    resetCompactedContext();
    contextRevision++;
    contextLeafId = ctx.sessionManager.getLeafId?.();
    snapshotContextUsage(ctx);
    requestRender?.();
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!state.runtimeActive) return;
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    requestStartedAt = undefined;
    contextLeafId = ctx.sessionManager.getLeafId?.();
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
    snapshotContextUsage(ctx);
    requestRender?.();
    maybeGenerateAgentTitle(ctx);
  });
  pi.on("session_shutdown", () => {
    state.runtimeActive = false;
    state.runtimeGeneration++;
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    requestFirstTokenAt = undefined;
    state.titleGenerationAbortController.abort();
    state.titleGenerationInFlight = false;
    for (const timer of bashRefreshTimers) clearTimeout(timer);
    bashRefreshTimers.clear();
    state.primeAgentContext?.ui.setWidget(PRIME_AGENT_WIDGET_KEY, undefined, {
      placement: "belowEditor",
    });
    disposeGitStatus(state.gitStatus);
    state.gitStatus = createGitStatusTracker(process.cwd());
    requestRender = undefined;
    state.footerData = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.loadedContextTokens = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
    state.contextUsageSnapshot = undefined;
    state.responseModel = undefined;
    state.checkContextEntries = undefined;
    contextLeafId = undefined;
    projectionLeafId = undefined;
    registeredLoadedContextTokens = undefined;
    runSystemPromptOptions = undefined;
    provenUsage = undefined;
    usageLoadedContextTokens = undefined;
    requestSystemPromptOverride = undefined;
    state.runtimeContext = undefined;
    state.primeAgentContext = undefined;
    state.primeAgentWidgetText = undefined;
    requestStartedAt = undefined;
  });
}
