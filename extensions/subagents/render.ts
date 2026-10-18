import type { Theme } from "@earendil-works/pi-coding-agent";

const PREVIEW_CHARS = 160;
const SEND_PREVIEW_CHARS = 60;

/**
 * Display data for one report, carried in message/tool-result `details` (never sent to
 * the model), so renderers do not parse report text that may contain look-alike lines.
 */
export interface ReportView {
  header: string;
  state: "done" | "failed" | "cancelled";
  error?: string;
  /** The body exactly as the model received it (possibly truncated with a path). */
  body: string;
}

export interface ReportDetails {
  reports: ReportView[];
  /** `wait`: names still queued or running. */
  pending?: string[];
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const oneLine = (value: string, max: number) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** One line per tool call. Arguments may be partial or malformed while streaming. */
export function renderCallLine(args: Record<string, unknown>, theme: Theme): string {
  const title = theme.fg("toolTitle", theme.bold("subagents "));
  const action = typeof args.action === "string" ? args.action : "";
  let target = "";
  if (action === "run") {
    const tasks = Array.isArray(args.tasks) ? args.tasks as unknown[] : [];
    target = tasks.map((task) => task && typeof task === "object" ? (task as { name?: unknown }).name : undefined).filter((name): name is string => typeof name === "string" && name !== "").join(", ");
  } else if (action === "send") {
    const name = typeof args.name === "string" ? args.name : "";
    const message = typeof args.message === "string" ? oneLine(args.message, SEND_PREVIEW_CHARS) : "";
    target = `${name}${message ? theme.fg("dim", ` ${message}`) : ""}`;
  } else if (action === "wait" || action === "stop") {
    const names = strings(args.names);
    target = names.length ? names.join(", ") : "all";
    if (action === "wait" && args.all === true && names.length) target += theme.fg("dim", " (all)");
  }
  return `${title}${theme.fg("accent", action)}${target ? ` ${target}` : ""}`;
}

/** Collapsed: header, error and a one-line body preview per report. Expanded: full bodies. */
export function renderReports(details: ReportDetails, expanded: boolean, theme: Theme): string {
  const out: string[] = [];
  for (const report of details.reports) {
    out.push(theme.fg(report.state === "failed" ? "error" : report.state === "cancelled" ? "warning" : "accent", report.header));
    if (report.error) out.push(theme.fg("error", `error: ${expanded ? report.error : oneLine(report.error, PREVIEW_CHARS)}`));
    if (expanded) { if (report.body) out.push(report.body); }
    else {
      const first = report.body.split("\n").find((line) => line.trim());
      if (first) out.push(theme.fg("dim", `⎿ ${oneLine(first, PREVIEW_CHARS)}`));
    }
  }
  if (details.pending?.length) out.push(theme.fg("dim", `pending: ${details.pending.join(", ")}`));
  return out.join("\n");
}

/** Accepts only details written by this extension; anything else renders as plain text. */
export function reportDetails(value: unknown): ReportDetails | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as ReportDetails).reports)) return undefined;
  return value as ReportDetails;
}

/** Tool result view. `details` carries reports for `wait`; other results are a short line. */
export function renderResultText(text: string, details: unknown, options: { expanded: boolean; isPartial: boolean; isError: boolean }, theme: Theme): string {
  if (options.isPartial) return theme.fg("dim", "waiting…");
  if (options.isError) return theme.fg("error", text);
  const reports = reportDetails(details);
  if (reports?.reports.length) return renderReports(reports, options.expanded, theme);
  if (options.expanded) return text;
  // `wait` without reports: "No new reports." plus the pending names, on one line.
  return theme.fg("dim", reports?.pending?.length ? `No new reports; pending: ${reports.pending.join(", ")}` : text.split("\n")[0] ?? "");
}
