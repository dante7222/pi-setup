import { isAbsolute, relative } from "node:path";
import type { Report } from "./manager.ts";
import type { ReportView } from "./render.ts";

// Model-facing report text. The parent pays for every character on each later
// request, so bodies are capped and the full text stays on disk.

/** Body limit for one report. */
export const REPORT_CHARS = 3000;
/** Every report keeps at least this much body, even in a wide batch. */
export const MIN_REPORT_CHARS = 800;
/** Body budget shared by reports delivered together, so a wide run cannot flood the parent. */
export const BATCH_CHARS = 12_000;
const ERROR_CHARS = 500;
/** Part of a truncated error kept from its start; the rest comes from its end, where a stderr tail names the cause. */
const ERROR_HEAD_CHARS = 150;
const MAX_FILES = 12;
/** Share of a truncated body kept from the start; the rest comes from the end, where verdicts and risks usually are. */
const HEAD_SHARE = 0.6;

/**
 * Body limits for reports delivered together. Reports shorter than their share keep
 * their full text and leave the rest of the budget to longer ones.
 */
export function reportLimits(lengths: readonly number[]): number[] {
  const limits = new Array<number>(lengths.length);
  let budget = BATCH_CHARS;
  let left = lengths.length;
  for (const index of lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b])) {
    const share = Math.min(REPORT_CHARS, Math.max(MIN_REPORT_CHARS, Math.floor(budget / left)));
    limits[index] = share;
    budget -= Math.min(lengths[index], share);
    left--;
  }
  return limits;
}

/**
 * Keep whole lines from the start and the end, and name the omitted line range so the
 * parent can read just that part of the full report instead of all of it.
 */
export function truncateBody(text: string, limit: number, path: string): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const size = (line: string) => line.length + 1;
  const headBudget = Math.floor(limit * HEAD_SHARE);
  let head = 0;
  let used = 0;
  while (head < lines.length && used + size(lines[head]) <= headBudget) used += size(lines[head++]);
  // A first line longer than the head budget is cut rather than dropped: it is usually the summary.
  const cut = head === 0 ? `${lines[0].slice(0, lines.length === 1 ? limit : headBudget)}…` : undefined;
  if (cut) used = size(cut);
  const keepFrom = cut ? 1 : head;
  let tail = lines.length;
  while (tail > keepFrom && used + size(lines[tail - 1]) <= limit) used += size(lines[--tail]);
  // 1-based range of lines not fully shown.
  const from = cut ? 1 : head + 1;
  const range = from === tail ? `line ${from}` : `lines ${from}-${tail}`;
  const marker = `[truncated ${range} of ${lines.length}; full report: ${path} (read offset=${from} limit=${tail - from + 1})]`;
  return [...(cut ? [cut] : lines.slice(0, head)), marker, ...lines.slice(tail)].join("\n");
}

/** Relative to the parent's cwd when inside it, otherwise absolute. */
function displayPath(path: string, cwd: string | undefined): string {
  const rel = cwd ? relative(cwd, path) : "";
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** The parts of a report as the model sees them; the TUI renders the same parts from `details`. */
export function reportView(report: Report, limit = REPORT_CHARS, cwd?: string): ReportView {
  const header = `[subagent ${report.name} ${report.state}${report.partial ? " partial" : ""} ${report.seconds}s ${Math.round(report.tokens / 1000)}k tok]`;
  const error = report.error && report.error.length > ERROR_CHARS ? `${report.error.slice(0, ERROR_HEAD_CHARS)} ... ${report.error.slice(ERROR_HEAD_CHARS + 5 - ERROR_CHARS)}` : report.error;
  const files = report.files ?? [];
  const edited = files.slice(0, MAX_FILES).map((file) => displayPath(file, cwd)).join(", ") + (files.length > MAX_FILES ? `, +${files.length - MAX_FILES} more` : "");
  const overlap = Object.entries(report.overlaps ?? {}).map(([file, names]) => `${displayPath(file, cwd)} (${names.join(", ")})`).join(", ");
  return { header, state: report.state, ...(error ? { error } : {}), ...(edited ? { edited } : {}), ...(overlap ? { overlap } : {}), body: truncateBody(report.text, limit, report.path) };
}

function viewText(view: ReportView): string {
  return [
    view.header,
    view.error ? `error: ${view.error}` : "",
    view.edited ? `edited: ${view.edited}` : "",
    view.overlap ? `overlap: ${view.overlap}` : "",
    view.body,
  ].filter(Boolean).join("\n");
}

export function formatReport(report: Report, limit = REPORT_CHARS, cwd?: string): string {
  return viewText(reportView(report, limit, cwd));
}

/** Reports delivered in one message or `wait` result, sharing one body budget. */
export function formatReports(reports: readonly Report[], cwd?: string): { text: string; views: ReportView[] } {
  const limits = reportLimits(reports.map((report) => report.text.length));
  const views = reports.map((report, index) => reportView(report, limits[index], cwd));
  return { text: views.map(viewText).join("\n\n"), views };
}
