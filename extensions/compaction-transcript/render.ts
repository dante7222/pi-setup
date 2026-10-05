import type {
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { Marked } from "@earendil-works/pi-tui";

const markdownParser = new Marked();

export interface TranscriptRenderOptions {
  entries: SessionEntry[];
  generatedAt: string;
  rawFileName: string;
  sessionId: string;
  title: string;
}

type StoredMessage = SessionMessageEntry["message"];
type UserContent = Extract<StoredMessage, { role: "user" }>["content"];
type StoredAssistant = Extract<StoredMessage, { role: "assistant" }>;

interface ReadingTurn {
  question: string[];
  response: string[];
  thinking: string[];
}

function userText(content: UserContent): string[] {
  if (typeof content === "string") return [content];

  const text: string[] = [];
  for (const block of content) {
    if (block.type === "text") text.push(block.text);
  }
  return text;
}

export function resolveTranscriptTitle(
  entries: SessionEntry[],
  sessionName: string | undefined,
): string {
  const normalizedSessionName = sessionName?.replace(/\s+/g, " ").trim();
  if (normalizedSessionName) return normalizedSessionName;

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;

    for (const text of userText(entry.message.content)) {
      const normalizedText = text.replace(/\s+/g, " ").trim();
      if (!normalizedText) continue;

      const characters = Array.from(normalizedText);
      return characters.length <= 72
        ? normalizedText
        : `${characters.slice(0, 69).join("")}…`;
    }
  }

  return "Conversation Transcript";
}

function markdownBoundary(text: string): string {
  // Parse the body rather than counting delimiter characters inside code. Root
  // separators end lists/quotes; root fences and raw HTML blocks need a closer
  // first or they would consume the status/answer of the following attempt.
  const last = markdownParser.lexer(text).findLast((token) => token.type !== "space");
  let close = "";
  if (last?.type === "code") {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(last.raw)?.[1];
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*$`);
      if (!last.raw.split("\n").slice(1).some((line) => closing.test(line))) close = fence;
    }
  } else if (last?.type === "html") {
    const raw = last.raw.trimStart();
    if (raw.startsWith("<!--") && !raw.includes("-->")) close = "-->";
    else if (raw.startsWith("<?") && !raw.includes("?>")) close = "?>";
    else if (raw.startsWith("<![CDATA[") && !raw.includes("]]>")) close = "]]>";
    else if (/^<![A-Z]/.test(raw) && !raw.includes(">")) close = ">";
    else {
      const tag = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(raw)?.[1];
      if (tag && !new RegExp(`</${tag}\\s*>`, "i").test(raw)) close = `</${tag}>`;
    }
  }
  return `${close ? `${close}\n\n` : ""}<!-- pi-transcript-response-boundary -->`;
}

function assistantText(message: StoredAssistant): Pick<ReadingTurn, "response" | "thinking"> {
  const response: string[] = [];
  const thinking: string[] = [];

  for (const block of message.content) {
    if (block.type === "text") response.push(block.text);
    if (block.type === "thinking") thinking.push(block.thinking);
  }

  const reason = message.stopReason === "aborted"
    ? "This assistant response was aborted."
    : message.stopReason === "error"
      ? "This assistant response ended with an error."
      : message.stopReason === "length"
        ? "This assistant response reached the output limit."
        : undefined;
  if (reason) {
    // Annotate this attempt, not the whole user turn: a later retry may finish.
    // Provider error payloads stay in the lossless sidecar, not the reading view.
    response.unshift(`> [!warning] Incomplete response\n> ${reason}`);
  }
  if (response.length > 0) response.push(markdownBoundary(response.join("\n\n")));

  return { response, thinking };
}

function readingTurns(entries: SessionEntry[]): ReadingTurn[] {
  const turns: ReadingTurn[] = [];
  let currentTurn: ReadingTurn | undefined;

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    if (entry.message.role === "user") {
      currentTurn = {
        question: userText(entry.message.content),
        response: [],
        thinking: [],
      };
      turns.push(currentTurn);
      continue;
    }

    if (entry.message.role !== "assistant" || currentTurn === undefined) continue;
    const content = assistantText(entry.message);
    currentTurn.thinking.push(...content.thinking);
    currentTurn.response.push(...content.response);
  }

  return turns;
}

function thinkingCallout(blocks: string[]): string {
  const body = blocks.join("\n\n");
  const lines = `${body}\n\n${markdownBoundary(body)}`.split("\n");
  return [
    "> [!abstract]- Model thinking",
    ...lines.map((line) => line.length === 0 ? ">" : `> ${line}`),
  ].join("\n");
}

function questionPreview(turn: ReadingTurn, index: number): string {
  const normalized = turn.question.join(" ").replace(/\s+/g, " ").trim();
  if (!normalized) return `Question ${index + 1}`;

  const characters = Array.from(normalized);
  const shortened = characters.length <= 72
    ? normalized
    : `${characters.slice(0, 69).join("")}…`;
  return shortened.replace(/[|[\]]/g, "");
}

function renderContents(turns: ReadingTurn[]): string {
  return [
    "## Contents",
    "",
    ...turns.map((turn, index) =>
      `- [[#Question ${index + 1}|${index + 1}. ${questionPreview(turn, index)}]]`),
  ].join("\n");
}

function renderTurn(turn: ReadingTurn, index: number): string {
  const sections = [`## Question ${index + 1}`];

  if (turn.question.length > 0) {
    const question = turn.question.join("\n\n");
    sections.push("", question, "", markdownBoundary(question));
  }

  const thinking = turn.thinking.filter((block) => block.length > 0);
  if (thinking.length > 0) {
    sections.push("", thinkingCallout(thinking));
  }

  const response = turn.response.filter((block) => block.length > 0);
  if (response.length > 0) {
    sections.push("", "### Response", "", response.join("\n\n"));
  }

  return sections.join("\n");
}

function headingText(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]])/g, "\\$1");
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

export function serializeActiveBranch(
  header: SessionHeader | null,
  entries: SessionEntry[],
): string {
  const records: unknown[] = header === null ? [...entries] : [header, ...entries];
  return `${records.map((record) => stringifyJson(record)).join("\n")}\n`;
}

export function renderTranscript(options: TranscriptRenderOptions): string {
  const turns = readingTurns(options.entries);
  const hiddenArchiveReference = [
    "<!-- pi-transcript",
    `session: ${options.sessionId}`,
    `captured: ${options.generatedAt}`,
    `lossless-sidecar: ${options.rawFileName}`,
    "-->",
  ].join("\n");

  return [
    `# ${headingText(options.title)}`,
    "",
    hiddenArchiveReference,
    "",
    turns.length === 0
      ? "_(No user questions with readable text were found.)_"
      : `${renderContents(turns)}\n\n---\n\n${turns.map(renderTurn).join("\n\n---\n\n")}`,
    "",
  ].join("\n");
}
