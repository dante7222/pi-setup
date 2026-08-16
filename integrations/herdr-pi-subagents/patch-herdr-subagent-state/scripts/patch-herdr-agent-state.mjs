#!/usr/bin/env node

import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INTEGRATION_MARKER = "HERDR_INTEGRATION_ID=pi";
const PATCH_MARKER = "HERDR_PI_SUBAGENTS_PATCH";
const WORKING_CONDITION = "if (agentActive || activeSubagents.size > 0)";
const ROOT_SESSION_ANCHOR = "  let rootSession = false;\n";
const AGENT_ACTIVE_ANCHOR = "    if (agentActive) {\n";
const SESSION_START_ANCHOR = '  pi.on("session_start", async (event, ctx) => {\n';

const SUBAGENT_DECLARATION = `${ROOT_SESSION_ANCHOR}  // ${PATCH_MARKER}: keep automatic background work from appearing idle in Herdr.\n  const activeSubagents = new Set<string>();\n`;

const SUBAGENT_HANDLERS = `  function trackSubagent(data: { id?: unknown } | undefined): void {
    if (!rootSession || typeof data?.id !== "string") {
      return;
    }
    activeSubagents.add(data.id);
    publishState();
  }

  function finishSubagent(data: { id?: unknown } | undefined): void {
    if (!rootSession || typeof data?.id !== "string") {
      return;
    }
    activeSubagents.delete(data.id);
    // pi-subagents queues a completion follow-up. Keep the last published state
    // until that turn settles, avoiding an idle notification between the two runs.
  }

  pi.events.on("subagents:created", trackSubagent);
  pi.events.on("subagents:started", trackSubagent);
  pi.events.on("subagents:completed", finishSubagent);
  pi.events.on("subagents:failed", finishSubagent);

${SESSION_START_ANCHOR}`;

function replaceUnique(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first === -1) {
    throw new Error(`Unsupported Herdr Pi integration: missing ${label} anchor.`);
  }
  if (source.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`Unsupported Herdr Pi integration: ${label} anchor is not unique.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function hasCompletePatch(source) {
  return source.includes(PATCH_MARKER)
    && source.includes(WORKING_CONDITION)
    && source.includes('pi.events.on("subagents:created", trackSubagent)')
    && source.includes('pi.events.on("subagents:started", trackSubagent)')
    && source.includes('pi.events.on("subagents:completed", finishSubagent)')
    && source.includes('pi.events.on("subagents:failed", finishSubagent)');
}

export function patchHerdrAgentState(source) {
  if (!source.includes(INTEGRATION_MARKER)) {
    throw new Error("Target is not Herdr's managed Pi integration.");
  }
  if (hasCompletePatch(source)) {
    return { changed: false, source };
  }
  if (source.includes(PATCH_MARKER) || source.includes(WORKING_CONDITION)) {
    throw new Error("Herdr Pi integration contains a partial subagent-state patch; refusing to guess.");
  }

  let patched = replaceUnique(
    source,
    ROOT_SESSION_ANCHOR,
    SUBAGENT_DECLARATION,
    "root session",
  );
  patched = replaceUnique(
    patched,
    AGENT_ACTIVE_ANCHOR,
    `    ${WORKING_CONDITION} {\n`,
    "agent activity",
  );
  patched = replaceUnique(
    patched,
    SESSION_START_ANCHOR,
    SUBAGENT_HANDLERS,
    "session start",
  );
  return { changed: true, source: patched };
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function defaultTargetPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR))
    : path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, "extensions", "herdr-agent-state.ts");
}

export async function patchHerdrAgentStateFile(targetPath = defaultTargetPath()) {
  const source = await readFile(targetPath, "utf8");
  const result = patchHerdrAgentState(source);
  if (!result.changed) return result;

  const fileStat = await stat(targetPath);
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, result.source, "utf8");
    await chmod(temporaryPath, fileStat.mode);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return result;
}

async function main() {
  const targetPath = process.argv[2]
    ? path.resolve(expandHome(process.argv[2]))
    : defaultTargetPath();
  const result = await patchHerdrAgentStateFile(targetPath);
  console.log(`${result.changed ? "Patched" : "Already patched"}: ${targetPath}`);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
