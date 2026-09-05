import { FILE_HEADERS_ONLY, formatPatch, structuredPatch, type StructuredPatch } from "diff";
import { SESSION_GROUP_CONTEXT_MAX_BYTES } from "./contracts.ts";

export interface SessionGroupContextDiff {
  diff: string;
  patch: string;
  coarse: boolean;
}

/**
 * Compute once before approval. Async, bounded edit-distance search avoids
 * freezing Pi on short-line documents. A linear whole-file hunk is an exact
 * (though less minimal) fallback, not a truncated or approximate patch.
 */
export async function createSessionGroupContextDiff(
  path: string,
  before: string,
  after: string,
  signal?: AbortSignal,
): Promise<SessionGroupContextDiff> {
  signal?.throwIfAborted();
  if ([before, after].some((text) => Buffer.byteLength(text, "utf8") > SESSION_GROUP_CONTEXT_MAX_BYTES)) {
    throw new Error("Cannot preview group context larger than 64 KiB.");
  }
  let patch = await new Promise<StructuredPatch | undefined>((resolve, reject) => {
    const aborted = () => reject(signal?.reason);
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      structuredPatch(path, path, before, after, undefined, undefined, {
        context: 4,
        timeout: 75,
        maxEditLength: 256,
        callback: (result) => {
          signal?.removeEventListener("abort", aborted);
          resolve(result);
        },
      });
    } catch (error) {
      signal?.removeEventListener("abort", aborted);
      reject(error);
    }
  });
  // The library has a bounded timeout rather than an AbortSignal. A cancelled
  // caller returns immediately; its pending search finishes within that budget.
  signal?.throwIfAborted();
  const coarse = patch === undefined;
  if (!patch) {
    const oldLines = before.match(/[^\n]*\n|[^\n]+/g) ?? [];
    const newLines = after.match(/[^\n]*\n|[^\n]+/g) ?? [];
    const lines: string[] = [];
    for (const [prefix, source] of [["-", oldLines], ["+", newLines]] as const) {
      for (const line of source) {
        lines.push(`${prefix}${line.endsWith("\n") ? line.slice(0, -1) : line}`);
        if (!line.endsWith("\n")) lines.push("\\ No newline at end of file");
      }
    }
    patch = {
      oldFileName: path,
      newFileName: path,
      oldHeader: undefined,
      newHeader: undefined,
      hunks: [{ oldStart: 1, newStart: 1, oldLines: oldLines.length, newLines: newLines.length, lines }],
    };
  }

  const output: string[] = [];
  for (const hunk of patch.hunks) {
    if (output.length > 0) output.push("  ...");
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        output.push(line);
      } else if (line.startsWith("+")) {
        output.push(`+${newLine++} ${line.slice(1)}`);
      } else if (line.startsWith("-")) {
        output.push(`-${oldLine++} ${line.slice(1)}`);
      } else {
        output.push(` ${oldLine++} ${line.slice(1)}`);
        newLine++;
      }
    }
  }
  return { diff: output.join("\n"), patch: formatPatch(patch, FILE_HEADERS_ONLY), coarse };
}
