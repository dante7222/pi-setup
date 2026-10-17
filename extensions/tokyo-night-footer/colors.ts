import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export const RESET_ALL = "\x1b[0m";
export const RESET_FOREGROUND = "\x1b[39m";
export const RESET_BACKGROUND = "\x1b[49m";

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

export function ansiColor(hex: string, channel: 38 | 48): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `\x1b[${channel};2;${red};${green};${blue}m`;
}

export function ansiForeground(hex: string): string {
  return ansiColor(hex, 38);
}

export function usesExactTokyoNight(theme: Theme): boolean {
  return theme.name === "tokyo-night" && theme.getColorMode() === "truecolor";
}

export function tone(theme: Theme, statusTone: StatusTone, text: string): string {
  if (usesExactTokyoNight(theme)) {
    return `${ansiForeground(TOKYO_NIGHT_TONES[statusTone])}${text}${RESET_FOREGROUND}`;
  }
  return theme.fg(SEMANTIC_TONES[statusTone], text);
}

function sessionAccentHex(name: string): string {
  let hash = 5381;
  for (let index = 0; index < name.length; index++) {
    hash = (((hash << 5) + hash) ^ name.charCodeAt(index)) >>> 0;
  }
  return TOKYO_NIGHT_SESSION_ACCENTS[hash % TOKYO_NIGHT_SESSION_ACCENTS.length]!;
}

export function sessionAccent(theme: Theme, name: string, text: string): string {
  if (usesExactTokyoNight(theme)) {
    return `${ansiForeground(sessionAccentHex(name))}${text}${RESET_FOREGROUND}`;
  }
  return theme.fg("borderAccent", text);
}
