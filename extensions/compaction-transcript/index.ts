import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  renderTranscript,
  resolveTranscriptTitle,
  serializeActiveBranch,
} from "./render.ts";

interface TranscriptPaths {
  directory: string;
  legacyMarkdown: string;
  markdown: string;
  markdownSuffix: string;
  raw: string;
}

let exportQueue: Promise<void> = Promise.resolve();

function filenameSlug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const bounded = Array.from(normalized).slice(0, 60).join("").replace(/[.-]+$/g, "");
  if (!bounded) return "conversation";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(bounded)
    ? `session-${bounded}`
    : bounded;
}

function transcriptPaths(
  sessionFile: string,
  raw: string,
  sessionId: string,
  title: string,
): TranscriptPaths {
  const extension = path.extname(sessionFile);
  const legacyStem = path.basename(sessionFile, extension);
  const directory = path.join(path.dirname(sessionFile), "transcripts");
  const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  const readableStem = `${filenameSlug(title)}--${sessionKey}`;
  const snapshotId = createHash("sha256").update(raw).digest("hex");

  return {
    directory,
    legacyMarkdown: path.join(directory, `${legacyStem}.md`),
    markdown: path.join(directory, `${readableStem}.md`),
    markdownSuffix: `--${sessionKey}.md`,
    raw: path.join(directory, `${readableStem}.${snapshotId}.active-branch.jsonl`),
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.promises.writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function removeSupersededMarkdown(paths: TranscriptPaths): Promise<void> {
  const currentName = path.basename(paths.markdown);
  const legacyName = path.basename(paths.legacyMarkdown);
  const names = await fs.promises.readdir(paths.directory);
  const superseded = names.filter(
    (name) => name !== currentName && (name === legacyName || name.endsWith(paths.markdownSuffix)),
  );
  await Promise.all(
    superseded.map((name) => fs.promises.rm(path.join(paths.directory, name), { force: true })),
  );
}

async function writeTranscript(ctx: ExtensionContext): Promise<TranscriptPaths> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new Error("Cannot persist a transcript for an in-memory --no-session conversation");
  }

  const entries = ctx.sessionManager.getBranch();
  const header = ctx.sessionManager.getHeader();
  const raw = serializeActiveBranch(header, entries);
  const sessionId = ctx.sessionManager.getSessionId();
  const title = resolveTranscriptTitle(entries, ctx.sessionManager.getSessionName());
  const paths = transcriptPaths(sessionFile, raw, sessionId, title);
  const markdown = renderTranscript({
    entries,
    generatedAt: new Date().toISOString(),
    rawFileName: path.basename(paths.raw),
    sessionId,
    title,
  });

  await fs.promises.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.promises.chmod(paths.directory, 0o700);

  // The content-addressed sidecar is committed first. The stable Markdown file
  // then acts as the atomic pointer to a complete, matching snapshot.
  await atomicWrite(paths.raw, raw);
  await atomicWrite(paths.markdown, markdown);
  await removeSupersededMarkdown(paths);

  return paths;
}

async function exportAndNotify(ctx: ExtensionContext): Promise<void> {
  const queuedExport = exportQueue.then(
    () => writeTranscript(ctx),
    () => writeTranscript(ctx),
  );
  exportQueue = queuedExport.then(
    () => undefined,
    () => undefined,
  );

  try {
    const paths = await queuedExport;
    if (ctx.hasUI) ctx.ui.notify(`Transcript updated: ${paths.markdown}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`Transcript export failed: ${message}`, "error");
  }
}

export default function compactionTranscript(pi: ExtensionAPI): void {
  pi.on("session_compact", async (_event, ctx) => {
    await exportAndNotify(ctx);
  });

  pi.registerCommand("transcript", {
    description: "Export the complete active branch to readable Markdown and lossless JSONL",
    handler: async (_args, ctx) => {
      await exportAndNotify(ctx);
    },
  });
}
