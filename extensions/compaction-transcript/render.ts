import type {
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

export interface TranscriptRenderOptions {
  entries: SessionEntry[];
  generatedAt: string;
  rawFileName: string;
  sessionId: string;
  title: string;
}

type StoredMessage = SessionMessageEntry["message"];
type UserContent = Extract<StoredMessage, { role: "user" }>["content"];
type AssistantContent = Extract<StoredMessage, { role: "assistant" }>["content"];

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

function assistantText(content: AssistantContent): Pick<ReadingTurn, "response" | "thinking"> {
  const response: string[] = [];
  const thinking: string[] = [];

  for (const block of content) {
    if (block.type === "text") response.push(block.text);
    if (block.type === "thinking") thinking.push(block.thinking);
  }

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
    const content = assistantText(entry.message.content);
    currentTurn.thinking.push(...content.thinking);
    currentTurn.response.push(...content.response);
  }

  return turns;
}

function thinkingCallout(blocks: string[]): string {
  const lines = blocks.join("\n\n").split("\n");
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
    sections.push("", turn.question.join("\n\n"));
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
