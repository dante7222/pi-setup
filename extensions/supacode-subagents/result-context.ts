import { escapeTerminalText } from "./terminal-text.ts";

export interface ResultGitContext {
  baseSha?: string;
  commit?: string;
  commits?: unknown[];
  changedFiles?: string[];
  status?: string;
}

export interface ParentWorkerResult {
  id: string;
  batchId?: string;
  batchTitle?: string;
  title: string;
  mode: "research" | "coding";
  state: "completed" | "failed";
  output: string;
  resultPath?: string;
  stderrPath?: string;
  worktreePath?: string;
  branch?: string;
  git?: ResultGitContext;
}

export interface TextTruncation {
  content: string;
  truncated: boolean;
}

export interface PerResultContextBudget {
  maxBytes: number;
  maxLines: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function decodeUtf8Prefix(buffer: Buffer, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(buffer.length, maxBytes); end > 0; end--) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // A UTF-8 code point can straddle the byte limit; retry before it.
    }
  }
  return "";
}

export function truncateContextHead(
  value: string,
  maxBytes: number,
  maxLines: number,
): TextTruncation {
  positiveInteger(maxBytes, "maxBytes");
  positiveInteger(maxLines, "maxLines");

  const lines = value.split(/\r?\n/);
  let content = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  const encoded = Buffer.from(content);
  if (encoded.length > maxBytes) {
    content = decodeUtf8Prefix(encoded, maxBytes);
    truncated = true;
  }
  return { content, truncated };
}

export function allocatePerResultContext(
  resultCount: number,
  totalBytes: number,
  totalLines: number,
): PerResultContextBudget {
  positiveInteger(resultCount, "resultCount");
  positiveInteger(totalBytes, "totalBytes");
  positiveInteger(totalLines, "totalLines");
  return {
    maxBytes: Math.max(1, Math.floor(totalBytes / resultCount)),
    maxLines: Math.max(1, Math.floor(totalLines / resultCount)),
  };
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function capCombinedResult(value: string, maxBytes: number, maxLines: number): string {
  const truncated = truncateContextHead(value, maxBytes, maxLines);
  if (!truncated.truncated) return truncated.content;

  const notice = "\n\n[Combined delegated result truncated; see the Full result artifacts above.]";
  const noticeBytes = Buffer.byteLength(notice);
  if (maxBytes <= noticeBytes || maxLines <= 2) return truncated.content;
  const body = truncateContextHead(value, maxBytes - noticeBytes, maxLines - 2).content.trimEnd();
  return `${body}${notice}`;
}

export function formatWorkerResults(
  results: ParentWorkerResult[],
  maxBytes: number,
  maxLines: number,
): string {
  positiveInteger(maxBytes, "maxBytes");
  positiveInteger(maxLines, "maxLines");
  if (results.length === 0) return "0/0 delegated tasks completed successfully.";
  results = results.map((result) => ({
    ...result,
    batchTitle: result.batchTitle && escapeTerminalText(result.batchTitle),
    title: escapeTerminalText(result.title),
    output: escapeTerminalText(result.output),
    resultPath: result.resultPath && escapeTerminalText(result.resultPath),
    stderrPath: result.stderrPath && escapeTerminalText(result.stderrPath),
    worktreePath: result.worktreePath && escapeTerminalText(result.worktreePath),
    branch: result.branch && escapeTerminalText(result.branch),
    git: result.git
      ? {
          ...result.git,
          status: result.git.status && escapeTerminalText(result.git.status),
          changedFiles: result.git.changedFiles?.map(escapeTerminalText),
        }
      : undefined,
  }));

  const successful = results.filter((result) => result.state === "completed").length;
  const batches = new Map<string, string>();
  for (const result of results) {
    if (result.batchId && result.batchTitle) batches.set(result.batchId, result.batchTitle);
  }
  const batchLine = batches.size === 1
    ? [...batches].map(([id, title]) => `Batch: ${title} (${id})\n`).join("")
    : batches.size > 1
      ? `Batches:\n${[...batches].map(([id, title]) => `- ${title} (${id})`).join("\n")}\n`
      : "";
  const header = `${successful}/${results.length} delegated task${results.length === 1 ? "" : "s"} completed successfully.\n${batchLine}`;
  const metadata = results.map((result) => [
    `Mode: ${result.mode}`,
    result.worktreePath ? `Worktree: ${result.worktreePath}` : undefined,
    result.branch ? `Branch: ${result.branch}` : undefined,
    result.git?.baseSha ? `Base: ${result.git.baseSha}` : undefined,
    result.git?.commit ? `Commit: ${result.git.commit}` : undefined,
    result.git?.commits ? `Commits since base: ${result.git.commits.length}` : undefined,
    result.git?.changedFiles ? `Changed paths: ${result.git.changedFiles.length}` : undefined,
    result.git?.status ? "Uncommitted changes: yes" : undefined,
    result.state === "completed" && result.mode === "coding" && result.worktreePath
      ? `Apply changes: \`/delegate-apply ${result.id}\``
      : undefined,
    result.resultPath ? `Full result: ${result.resultPath}` : undefined,
    result.state === "failed" && result.stderrPath ? `Errors/log: ${result.stderrPath}` : undefined,
  ].filter((item): item is string => Boolean(item)));
  const staticSections = results.map((result, index) =>
    `## ${result.title} — ${result.state}\n\n${metadata[index].join("\n")}\n\n`);
  const staticText = `${header}\n${staticSections.join("\n\n---\n\n")}`;
  const truncationReserveBytes = results.length * 80;
  const truncationReserveLines = results.length * 2;
  const outputBytes = Math.max(
    results.length,
    maxBytes - Buffer.byteLength(staticText) - truncationReserveBytes,
  );
  const outputLines = Math.max(
    results.length,
    maxLines - lineCount(staticText) - truncationReserveLines,
  );
  const budget = allocatePerResultContext(results.length, outputBytes, outputLines);
  const sections = results.map((result, index) => {
    const output = truncateContextHead(result.output, budget.maxBytes, budget.maxLines);
    const omitted = output.truncated
      ? result.resultPath
        ? "\n\n[Result truncated; see Full result above.]"
        : "\n\n[Result truncated; no full-result artifact is available.]"
      : "";
    return `${staticSections[index]}${output.content}${omitted}`;
  });
  return capCombinedResult(`${header}\n${sections.join("\n\n---\n\n")}`, maxBytes, maxLines);
}
