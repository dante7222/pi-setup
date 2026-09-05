import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

/** File/model text is not terminal markup. Escape controls before adding theme ANSI. */
export function escapeSessionGroupDisplay(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Keep both sides of large replacements, including useful fragments of giant lines. */
export function previewSessionGroupDiff(diff: string, maxBytes: number, maxLines: number): string {
  const lineBudget = Math.floor(maxBytes / 3);
  const lines = escapeSessionGroupDisplay(diff).split("\n").map((line) => {
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length <= lineBudget) return line;
    const marker = ` … [line clipped: ${bytes.length} bytes] … `;
    const sideBytes = Math.floor((lineBudget - Buffer.byteLength(marker)) / 2);
    let headEnd = sideBytes;
    let tailStart = bytes.length - sideBytes;
    while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
    while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
    return `${bytes.subarray(0, headEnd).toString("utf8")}${marker}${bytes.subarray(tailStart).toString("utf8")}`;
  });
  const text = lines.join("\n");
  const full = truncateHead(text, { maxBytes, maxLines });
  if (!full.truncated) return text;
  const options = { maxBytes: Math.floor((maxBytes - 128) / 2), maxLines: Math.floor((maxLines - 4) / 2) };
  return `${truncateHead(text, options).content}\n… middle of diff omitted …\n${truncateTail(text, options).content}`;
}
