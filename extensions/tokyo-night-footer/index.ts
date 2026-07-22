import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
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
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  createGitStatusTracker,
  ensureGitStatus,
  type GitStatusTracker,
  invalidateGitStatus,
} from "./git-status.ts";

// Visual layout adapted from oh-my-pi's MIT-licensed editor status line.
const LEGACY_SESSION_NAME_STATUS_KEY = "ventris-session-name";
const LEGACY_TPS_STATUS_KEY = "ventris-tps";
const PERMISSION_STATUS_KEY = "pi-permission-system";
const TPS_ICON_NERD = "󰓅";
const TPS_ICON_FALLBACK = "⚡";
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
  | "path"
  | "gitClean"
  | "gitDirty"
  | "context"
  | "tps"
  | "separator";

const TOKYO_NIGHT_TONES: Record<StatusTone, string> = {
  pi: "#7dcfff",
  model: "#bb9af7",
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
  liveContextTokens: number | undefined;
  footerData: ReadonlyFooterDataProvider | undefined;
  gitStatus: GitStatusTracker;
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

  const background = usesExactTokyoNight(theme)
    ? ansiColor(TOKYO_NIGHT_ULTRAVIOLET, 48)
    : theme.getBgAnsi("customMessageLabel");
  const foreground = usesExactTokyoNight(theme)
    ? ansiForeground(TOKYO_NIGHT_BACKGROUND)
    : theme.getFgAnsi("toolPendingBg");
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
  if (id.startsWith("status:")) return 85;
  if (id === "context") return 80;
  if (id === "path") return 75;
  if (id === "tps") return 65;
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

function contextSegment(
  ctx: ExtensionContext,
  theme: Theme,
  liveContextTokens: number | undefined,
  nerdIcons: boolean,
): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextTokens = liveContextTokens ?? usage?.tokens;
  const percent =
    liveContextTokens !== undefined && contextWindow > 0
      ? (liveContextTokens / contextWindow) * 100
      : usage?.percent ??
        (contextTokens !== null && contextTokens !== undefined && contextWindow > 0
          ? (contextTokens / contextWindow) * 100
          : 0);
  const display =
    contextWindow <= 0
      ? "?/?"
      : contextTokens === null || contextTokens === undefined
        ? `?/${formatTokens(contextWindow)}`
        : `${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`;
  const text = withIcon(nerdIcons ? CONTEXT_ICON_NERD : CONTEXT_ICON_FALLBACK, display);

  if (percent > 90) return theme.fg("error", text);
  if (percent > 70) return theme.fg("warning", text);
  return tone(theme, "context", text);
}

function usageTokenTotal(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function modelName(ctx: ExtensionContext): string {
  let name = sanitizeSingleLine(ctx.model?.name ?? ctx.model?.id ?? "no-model");
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
    content: tone(theme, "model", withIcon("◉", modelName(ctx))),
  });

  if (ctx.model?.reasoning) {
    const thinking = pi.getThinkingLevel();
    if (thinking !== "off") {
      const color = THINKING_COLORS[thinking] ?? "thinkingText";
      segments.push({ id: "thinking", content: theme.fg(color, withIcon("●", thinking)) });
    }
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
        isDirty ? "gitDirty" : "gitClean",
        withIcon(
          nerdIcons ? GIT_BRANCH_ICON_NERD : GIT_BRANCH_ICON_FALLBACK,
          branchText,
        ),
      ),
    ];
    if (unstaged > 0) gitParts.push(theme.fg("warning", `*${unstaged}`));
    if (staged > 0) gitParts.push(theme.fg("success", `+${staged}`));
    if (untracked > 0) gitParts.push(theme.fg("muted", `?${untracked}`));
    segments.push({ id: "git", content: gitParts.join(" ") });
  }

  segments.push(...otherStatuses);
  segments.push({
    id: "context",
    content: contextSegment(ctx, theme, state.liveContextTokens, nerdIcons),
  });

  if (state.latestTps !== undefined) {
    const icon = nerdIcons ? TPS_ICON_NERD : TPS_ICON_FALLBACK;
    segments.push({
      id: "tps",
      content: tone(theme, "tps", withIcon(icon, `${state.latestTps.toFixed(1)} tok/s`)),
    });
  }

  return segments;
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
  const sessionName = sanitizeSingleLine(pi.getSessionName() ?? "");
  const border = sessionName
    ? (text: string) => sessionAccent(theme, sessionName, text)
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
  const maxSessionWidth = Math.max(1, Math.min(60, availableWidth - 2));
  const rightSegments: StatusSegment[] = sessionName
    ? [
        {
          id: "session",
          content: sessionAccent(
            theme,
            sessionName,
            theme.bold(truncateToWidth(sessionName, maxSessionWidth, "…")),
          ),
        },
      ]
    : [];

  let left = renderStatusGroup(leftSegments, "left", theme, nerdIcons);
  const right = renderStatusGroup(rightSegments, "right", theme, nerdIcons);

  // The right-aligned session title is the identity of parent and worker panes.
  // Keep it visible while progressively removing lower-priority status details.
  while (visibleWidth(left) + visibleWidth(right) > availableWidth && leftSegments.length > 1) {
    leftSegments.splice(leastImportantSegmentIndex(leftSegments), 1);
    left = renderStatusGroup(leftSegments, "left", theme, nerdIcons);
  }
  if (visibleWidth(left) + visibleWidth(right) > availableWidth && leftSegments.length === 1) {
    const groupChromeWidth = 2;
    const leftBudget = Math.max(0, availableWidth - visibleWidth(right));
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
    } else {
      left = "";
    }
  }
  if (visibleWidth(left) + visibleWidth(right) > availableWidth) left = "";

  const gapWidth = Math.max(0, availableWidth - visibleWidth(left) - visibleWidth(right));
  return `${border("╭──")}${left}${border("─".repeat(gapWidth))}${right}${border("──╮")}`;
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

  render(width: number): string[] {
    this.#refreshGitStatus();
    const sessionName = sanitizeSingleLine(this.#pi.getSessionName() ?? "");
    this.borderColor = sessionName
      ? (text: string) => sessionAccent(this.#ctx.ui.theme, sessionName, text)
      : (text: string) => this.#ctx.ui.theme.fg("border", text);

    if (width < 8) return super.render(width);

    const lines = super.render(width - 6);
    if (lines.length === 0) return lines;
    const bottomBorderIndex = findBottomBorderIndex(lines);
    if (bottomBorderIndex === -1) return super.render(width);

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
    liveContextTokens: undefined,
    footerData: undefined,
    gitStatus: createGitStatusTracker(process.cwd()),
  };
  let requestRender: (() => void) | undefined;
  let turnStartedAt: number | undefined;

  const refreshGitStatus = (force = false) => {
    const tracker = state.gitStatus;
    if (force) invalidateGitStatus(tracker);
    ensureGitStatus(pi, tracker, () => {
      if (state.gitStatus === tracker) requestRender?.();
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    invalidateGitStatus(state.gitStatus);
    state.latestTps = undefined;
    state.liveContextTokens = undefined;
    state.footerData = undefined;
    state.gitStatus = createGitStatusTracker(ctx.cwd);
    requestRender = undefined;
    turnStartedAt = undefined;
    ctx.ui.setStatus(LEGACY_SESSION_NAME_STATUS_KEY, undefined);
    ctx.ui.setStatus(LEGACY_TPS_STATUS_KEY, undefined);

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
  });

  pi.on("turn_start", () => {
    state.liveContextTokens = undefined;
    turnStartedAt = performance.now();
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    state.liveContextTokens = undefined;
    if (turnStartedAt === undefined) turnStartedAt = performance.now();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const contextTokens = usageTokenTotal(event.message.usage);
    if (contextTokens > 0) state.liveContextTokens = contextTokens;
    requestRender?.();
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    const elapsedMs = turnStartedAt === undefined ? 0 : performance.now() - turnStartedAt;
    const outputTokens = event.message.usage.output;
    const completed =
      event.message.stopReason !== "error" && event.message.stopReason !== "aborted";

    if (completed && outputTokens > 0 && elapsedMs >= 100) {
      state.latestTps = outputTokens / (elapsedMs / 1_000);
    }
    state.liveContextTokens = undefined;
    turnStartedAt = undefined;
    requestRender?.();
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
      refreshGitStatus(true);
    }
  });

  pi.on("user_bash", () => {
    const tracker = state.gitStatus;
    for (const delay of [100, 500, 1_500]) {
      setTimeout(() => {
        if (state.gitStatus === tracker) refreshGitStatus(true);
      }, delay);
    }
  });

  pi.on("turn_end", () => {
    turnStartedAt = undefined;
    refreshGitStatus(true);
  });
  pi.on("session_info_changed", () => requestRender?.());
  pi.on("model_select", () => {
    state.liveContextTokens = undefined;
    requestRender?.();
  });
  pi.on("thinking_level_select", () => requestRender?.());
  pi.on("session_compact", () => {
    state.liveContextTokens = undefined;
    requestRender?.();
  });
  pi.on("session_tree", () => {
    state.liveContextTokens = undefined;
    requestRender?.();
  });
  pi.on("session_shutdown", () => {
    invalidateGitStatus(state.gitStatus);
    state.gitStatus = createGitStatusTracker(process.cwd());
    requestRender = undefined;
    state.footerData = undefined;
    state.liveContextTokens = undefined;
    turnStartedAt = undefined;
  });
}
