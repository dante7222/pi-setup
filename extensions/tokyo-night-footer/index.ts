import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const THINKING_COLORS: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

function sanitizeSingleLine(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function sanitizeStatusText(text: string): string {
  // Preserve ANSI styling supplied by extensions while preventing multiline status output.
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
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

function collectUsage(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const message = entry.message as AssistantMessage;
    totals.input += message.usage.input;
    totals.output += message.usage.output;
    totals.cacheRead += message.usage.cacheRead;
    totals.cacheWrite += message.usage.cacheWrite;
    totals.cost += message.usage.cost.total;

    const promptTokens =
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    totals.latestCacheHitRate =
      promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
  }

  return totals;
}

function topLine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  branch: string | null,
  width: number,
): string {
  const marker = theme.bold(theme.fg("accent", "◆"));
  const name = sanitizeSingleLine(pi.getSessionName() ?? "");
  const cwd = formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
  const location = theme.fg("muted", cwd);
  const branchPart = branch
    ? `${theme.fg("dim", " ")}${theme.fg("customMessageLabel", `(${branch})`)}`
    : "";

  // Keep the session name at the beginning so truncation sacrifices location detail first.
  const content = name
    ? `${marker} ${theme.bold(theme.fg("borderAccent", name))}${theme.fg("dim", "  ·  ")}${location}${branchPart}`
    : `${marker} ${location}${branchPart}`;

  return truncateToWidth(content, width, theme.fg("dim", "…"));
}

function contextPart(ctx: ExtensionContext, theme: Theme): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = usage?.percent;
  const display =
    percent === null
      ? `?/${formatTokens(contextWindow)}`
      : `${(percent ?? 0).toFixed(1)}%/${formatTokens(contextWindow)}`;

  if ((percent ?? 0) > 90) return theme.fg("error", display);
  if ((percent ?? 0) > 70) return theme.fg("warning", display);
  return theme.fg("success", display);
}

function statsLine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  availableProviderCount: number,
  width: number,
): string {
  const totals = collectUsage(ctx);
  const parts: string[] = [];

  if (totals.input) parts.push(theme.fg("accent", `↑${formatTokens(totals.input)}`));
  if (totals.output) parts.push(theme.fg("borderAccent", `↓${formatTokens(totals.output)}`));
  if (totals.cacheRead) {
    parts.push(theme.fg("customMessageLabel", `R${formatTokens(totals.cacheRead)}`));
  }
  if (totals.cacheWrite) {
    parts.push(theme.fg("syntaxNumber", `W${formatTokens(totals.cacheWrite)}`));
  }
  if (
    (totals.cacheRead > 0 || totals.cacheWrite > 0) &&
    totals.latestCacheHitRate !== undefined
  ) {
    parts.push(theme.fg("success", `CH${totals.latestCacheHitRate.toFixed(1)}%`));
  }

  const model = ctx.model;
  const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
  if (totals.cost || usingSubscription) {
    const subscription = usingSubscription ? theme.fg("dim", " (sub)") : "";
    parts.push(theme.fg("warning", `$${totals.cost.toFixed(3)}`) + subscription);
  }

  parts.push(contextPart(ctx, theme));
  const left = parts.join(theme.fg("dim", " "));

  const modelName = model?.id ?? "no-model";
  const modelPart = theme.fg("accent", modelName);
  let rightWithoutProvider = modelPart;
  if (model?.reasoning) {
    const thinking = pi.getThinkingLevel();
    const thinkingColor = THINKING_COLORS[thinking] ?? "thinkingText";
    rightWithoutProvider = `${modelPart}${theme.fg("dim", " · ")}${theme.fg(thinkingColor, thinking)}`;
  }

  let right = rightWithoutProvider;
  if (availableProviderCount > 1 && model) {
    const withProvider = `${theme.fg("dim", `(${model.provider}) `)}${rightWithoutProvider}`;
    if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
  }

  const leftWidth = visibleWidth(left);
  if (leftWidth >= width) return truncateToWidth(left, width, theme.fg("dim", "…"));

  const availableForRight = width - leftWidth - 2;
  if (availableForRight <= 0) return truncateToWidth(left, width, theme.fg("dim", "…"));

  const fittedRight = truncateToWidth(right, availableForRight, theme.fg("dim", "…"));
  const padding = " ".repeat(Math.max(2, width - leftWidth - visibleWidth(fittedRight)));
  return left + padding + fittedRight;
}

export default function (pi: ExtensionAPI): void {
  let requestRender: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const render = () => tui.requestRender();
      requestRender = render;
      const unsubscribe = footerData.onBranchChange(render);

      return {
        invalidate() {},
        dispose() {
          unsubscribe();
          if (requestRender === render) requestRender = undefined;
        },
        render(width: number): string[] {
          if (width <= 0) return [""];

          const lines = [
            topLine(pi, ctx, theme, footerData.getGitBranch(), width),
            statsLine(pi, ctx, theme, footerData.getAvailableProviderCount(), width),
          ];

          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatusText(text))
            .filter(Boolean);

          if (statuses.length > 0) {
            const statusLine = statuses.join(theme.fg("dim", "  ·  "));
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
          }

          return lines;
        },
      };
    });
  });

  pi.on("session_info_changed", () => requestRender?.());
  pi.on("model_select", () => requestRender?.());
  pi.on("thinking_level_select", () => requestRender?.());
  pi.on("session_compact", () => requestRender?.());
  pi.on("turn_end", () => requestRender?.());
}
