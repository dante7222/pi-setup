const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function escapedCodePoint(value: string): string {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return "";
  if (value === "\t") return "\\t";
  if (value === "\r") return "\\r";
  return codePoint <= 0xffff
    ? `\\u${codePoint.toString(16).padStart(4, "0")}`
    : `\\u{${codePoint.toString(16)}}`;
}

/** Preserve ordinary newlines while making terminal and bidi controls visible. */
export function escapeTerminalText(value: string): string {
  return value.replace(TERMINAL_CONTROL_PATTERN, escapedCodePoint);
}
