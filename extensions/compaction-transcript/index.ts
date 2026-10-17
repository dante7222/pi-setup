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
  /** Matches every snapshot sidecar that belongs to this session. */
  rawPattern: RegExp;
  legacyMarkdown: string;
  markdown: string;
  markdownSuffix: string;
  raw: string;
}

const MAX_FILENAME_BYTES = 255;
/** Sidecars kept per session, including the one the current Markdown references. */
export const RETAINED_SNAPSHOTS = 3;
let exportQueue: Promise<void> = Promise.resolve();

function filenameSlug(value: string, maxBytes: number): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  let prefix = "";
  let bytes = 0;
  for (const character of Array.from(normalized).slice(0, 60)) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    prefix += character;
    bytes += size;
  }
  const bounded = prefix.replace(/[.-]+$/g, "");
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
  const snapshotId = createHash("sha256").update(raw).digest("hex");
  const snapshotSuffix = `.${snapshotId}.active-branch.jsonl`;
  const keySuffix = `--${sessionKey}`;
  // Budget the longest published basename in UTF-8 bytes, not characters.
  const slugBudget = MAX_FILENAME_BYTES - Buffer.byteLength(keySuffix + snapshotSuffix, "utf8");
  const readableStem = `${filenameSlug(title, slugBudget)}${keySuffix}`;

  return {
    directory,
    legacyMarkdown: path.join(directory, `${legacyStem}.md`),
    markdown: path.join(directory, `${readableStem}.md`),
    markdownSuffix: `--${sessionKey}.md`,
    rawPattern: new RegExp(`--${sessionKey}\\.[a-f0-9]{64}\\.active-branch\\.jsonl$`),
    raw: path.join(directory, `${readableStem}${snapshotSuffix}`),
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  // Keep the temporary name short and in the same directory for atomic rename.
  // Appending a UUID to a valid long destination can exceed NAME_MAX again.
  const temporaryPath = path.join(path.dirname(filePath), `.pi-transcript-${randomUUID()}.tmp`);

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

/**
 * Keep the newest RETAINED_SNAPSHOTS sidecars of this session. The current one
 * is always kept because the published Markdown points at it.
 */
async function pruneSnapshots(paths: TranscriptPaths): Promise<void> {
  const currentName = path.basename(paths.raw);
  const names = await fs.promises.readdir(paths.directory);
  const older = names.filter((name) => name !== currentName && paths.rawPattern.test(name));
  if (older.length < RETAINED_SNAPSHOTS) return;
  const dated = await Promise.all(older.map(async (name) => {
    try {
      return { name, mtime: (await fs.promises.stat(path.join(paths.directory, name))).mtimeMs };
    } catch {
      return { name, mtime: -1 };
    }
  }));
  // Name breaks mtime ties on coarse-timestamp filesystems so pruning stays deterministic.
  dated.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  await Promise.all(dated.slice(RETAINED_SNAPSHOTS - 1).map(({ name }) =>
    fs.promises.rm(path.join(paths.directory, name), { force: true })));
}

interface TranscriptSnapshot {
  entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
  raw: string;
  sessionFile: string;
  sessionId: string;
  title: string;
}

/**
 * Read everything from ctx synchronously, before queueing. A queued export may
 * run after a session switch or reload, when the captured ctx is stale and
 * every getter throws.
 */
function captureSnapshot(ctx: ExtensionContext): TranscriptSnapshot {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new Error("Cannot persist a transcript for an in-memory --no-session conversation");
  }
  const entries = ctx.sessionManager.getBranch();
  return {
    entries,
    raw: serializeActiveBranch(ctx.sessionManager.getHeader(), entries),
    sessionFile,
    sessionId: ctx.sessionManager.getSessionId(),
    title: resolveTranscriptTitle(entries, ctx.sessionManager.getSessionName()),
  };
}

async function writeTranscript(snapshot: TranscriptSnapshot): Promise<TranscriptPaths> {
  const { entries, raw, sessionFile, sessionId, title } = snapshot;
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
  // Pruning is best-effort: the export already succeeded at this point.
  await pruneSnapshots(paths).catch(() => undefined);

  return paths;
}

/** Notification is best effort: a stale ctx throws on access, so never rethrow. */
function notify(ctx: ExtensionContext, message: string, type: "info" | "error"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  } catch {
    // The session was replaced or reloaded; there is no UI to report to.
  }
}

async function exportAndNotify(ctx: ExtensionContext): Promise<void> {
  try {
    const snapshot = captureSnapshot(ctx);
    const queuedExport = exportQueue.then(
      () => writeTranscript(snapshot),
      () => writeTranscript(snapshot),
    );
    exportQueue = queuedExport.then(
      () => undefined,
      () => undefined,
    );
    const paths = await queuedExport;
    notify(ctx, `Transcript updated: ${paths.markdown}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Transcript export failed: ${message}`, "error");
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
