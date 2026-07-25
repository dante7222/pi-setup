import { truncateContextHead } from "./result-context.ts";

export const MAX_WORKER_RESULT_BYTES = 1024 * 1024;
export const MAX_WORKER_RESULT_LINES = 20_000;
export const MAX_REVIEW_EVIDENCE_BYTES = 64 * 1024;
export const MAX_REVIEW_EVIDENCE_LINES = 1_000;

export function boundedArtifactText(
  value: string,
  maxBytes = MAX_WORKER_RESULT_BYTES,
  maxLines = MAX_WORKER_RESULT_LINES,
): string {
  const normalized = value.trim();
  const direct = truncateContextHead(normalized, maxBytes, maxLines);
  if (!direct.truncated) {
    return Buffer.byteLength(direct.content) < maxBytes
      ? `${direct.content}\n`
      : direct.content;
  }

  const notice = "\n\n[Artifact truncated at its configured byte or line limit.]";
  const noticeBytes = Buffer.byteLength(notice);
  if (maxBytes <= noticeBytes + 1 || maxLines <= 2) {
    return truncateContextHead(normalized, maxBytes, maxLines).content;
  }
  const body = truncateContextHead(
    normalized,
    maxBytes - noticeBytes - 1,
    maxLines - 2,
  ).content.trimEnd();
  return `${body}${notice}\n`;
}
