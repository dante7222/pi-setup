#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectBin = join(projectRoot, "node_modules", ".bin");
const lockPath = join(projectRoot, ".pi-runtime-sync.lock");
const packageNames = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function executableOnPath(name) {
  const override = process.env.PI_RUNTIME_BIN?.trim();
  if (override) {
    try {
      accessSync(resolve(override), constants.X_OK);
      return realpathSync(resolve(override));
    } catch {
      throw new Error(`PI_RUNTIME_BIN is not an executable file: ${override}`);
    }
  }

  const projectBinReal = existsSync(projectBin) ? realpathSync(projectBin) : projectBin;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    let directory;
    try {
      directory = realpathSync(entry);
    } catch {
      directory = resolve(entry);
    }
    if (directory === projectBinReal) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

function packageRootFromEntry(entryPath, expectedName) {
  let directory = dirname(entryPath);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (manifest.name === expectedName) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate package ${expectedName} from ${entryPath}.`);
}

function activeRuntime() {
  const piExecutable = executableOnPath("pi");
  if (!piExecutable) return undefined;
  const piRoot = packageRootFromEntry(piExecutable, "@earendil-works/pi-coding-agent");
  const versions = new Map();
  for (const packageName of packageNames) {
    const packageRoot = packageName === "@earendil-works/pi-coding-agent"
      ? piRoot
      : join(piRoot, "node_modules", ...packageName.split("/"));
    const manifest = readJson(join(packageRoot, "package.json"));
    if (manifest.name !== packageName) {
      throw new Error(`Expected ${packageName} at ${packageRoot}, found ${manifest.name ?? "an unnamed package"}.`);
    }
    versions.set(packageName, manifest.version);
  }
  const cliVersion = execFileSync(piExecutable, ["--version"], { encoding: "utf8" }).trim();
  const packageVersion = versions.get("@earendil-works/pi-coding-agent");
  if (cliVersion !== packageVersion) {
    throw new Error(`Pi CLI reports ${cliVersion}, but ${piRoot}/package.json reports ${packageVersion}.`);
  }
  return { piExecutable, versions };
}

function localRuntimeMatches(versions) {
  const manifest = readJson(join(projectRoot, "package.json"));
  const lock = readJson(join(projectRoot, "package-lock.json"));
  for (const [packageName, version] of versions) {
    if (manifest.devDependencies?.[packageName] !== version) return false;
    if (lock.packages?.[`node_modules/${packageName}`]?.version !== version) return false;
    const localManifest = join(projectRoot, "node_modules", ...packageName.split("/"), "package.json");
    if (!existsSync(localManifest) || readJson(localManifest).version !== version) return false;
  }
  return true;
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function acquireSyncLock() {
  const deadline = Date.now() + 10 * 60_000;
  const ownerToken = randomUUID();
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        ownerToken,
        createdAt: new Date().toISOString(),
      })}\n`);
      await handle.close();
      return ownerToken;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = readJson(lockPath);
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 5000) {
            throw new Error(`Malformed Pi runtime sync lock at ${lockPath}; remove it after confirming no sync is running.`);
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        await delay(100);
        continue;
      }
      if (!processExists(owner.pid)) {
        throw new Error(`Stale Pi runtime sync lock at ${lockPath}; remove it after confirming no sync is running.`);
      }
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for ${lockPath}.`);
}

async function releaseSyncLock(ownerToken) {
  let owner;
  try {
    owner = readJson(lockPath);
  } catch {
    return;
  }
  if (owner.ownerToken === ownerToken && owner.pid === process.pid) {
    await rm(lockPath, { force: true });
  }
}

function pinnedLocalRuntime() {
  const manifest = readJson(join(projectRoot, "package.json"));
  const versions = new Map();
  for (const packageName of packageNames) {
    const version = manifest.devDependencies?.[packageName];
    if (typeof version !== "string" || !version) {
      throw new Error(`No exact local development pin exists for ${packageName}.`);
    }
    versions.set(packageName, version);
  }
  if (!localRuntimeMatches(versions)) {
    throw new Error("The pinned local Pi runtime is incomplete; run npm ci or npm run sync-pi-runtime.");
  }
  return versions;
}

async function main() {
  const requireActive = process.argv.includes("--require-active");
  let runtime = activeRuntime();
  if (!runtime) {
    if (requireActive) {
      throw new Error(`Could not find pi on PATH outside ${projectBin}.`);
    }
    const versions = pinnedLocalRuntime();
    console.log(`No external Pi executable found; using pinned local runtime ${versions.get("@earendil-works/pi-coding-agent")}.`);
    return;
  }
  if (localRuntimeMatches(runtime.versions)) {
    console.log(`Pi development runtime already aligned with ${runtime.piExecutable} (${runtime.versions.get("@earendil-works/pi-coding-agent")}).`);
    return;
  }

  const ownerToken = await acquireSyncLock();
  try {
    runtime = activeRuntime();
    if (!runtime) throw new Error("The active Pi executable disappeared during synchronization.");
    if (localRuntimeMatches(runtime.versions)) return;
    const specs = packageNames.map((packageName) => `${packageName}@${runtime.versions.get(packageName)}`);
    console.log(`Synchronizing local Pi development runtime with ${runtime.piExecutable}: ${specs.join(", ")}`);
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(
      npmCommand,
      [
        "install",
        "--save-dev",
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...specs,
      ],
      { cwd: projectRoot, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm install exited with ${result.status ?? "unknown status"}.`);
    if (!localRuntimeMatches(runtime.versions)) {
      throw new Error("npm install completed, but the local Pi runtime still does not match the active runtime.");
    }
  } finally {
    await releaseSyncLock(ownerToken);
  }
}

await main();
