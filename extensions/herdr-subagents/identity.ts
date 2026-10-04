import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { snapshotProcesses } from "./process-tree.ts";

const exec = promisify(execFile);
export interface ProcessIdentity { pid: number; start: string; boot: string }
let boot: Promise<string> | undefined;

/** Boot + process start identity fences stale PID reuse. ps still has second precision. */
export async function bootIdentity(): Promise<string> {
  boot ??= (async () => {
    if (process.platform === "linux") return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (process.platform === "darwin") {
      const { stdout } = await exec("/usr/sbin/sysctl", ["-n", "kern.boottime"], { timeout: 5000, env: { LC_ALL: "C" } });
      return stdout.trim();
    }
    throw new Error("Subagents require macOS or Linux process identity support.");
  })();
  try { return await boot; } catch (error) { boot = undefined; throw error; }
}

export async function processIdentity(pid = process.pid): Promise<ProcessIdentity | undefined> {
  const [entries, currentBoot] = await Promise.all([snapshotProcesses(), bootIdentity()]);
  const entry = entries.find((item) => item.pid === pid && !/^[ZX]/.test(item.state));
  return entry ? { pid, start: entry.start, boot: currentBoot } : undefined;
}

export async function identityAlive(identity: ProcessIdentity): Promise<boolean> {
  const current = await processIdentity(identity.pid);
  return current?.start === identity.start && current.boot === identity.boot;
}
