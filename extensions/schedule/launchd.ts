// LaunchAgent for the background dispatcher: one plist, one label, a tick every 60s.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const LABEL = "dev.ventris.pi-schedule";
export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const run = promisify(execFile);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

export interface AgentConfig {
  /** Absolute node binary; launchd's minimal PATH cannot find an nvm node. */
  node: string;
  dispatch: string;
  dir: string;
  /** Environment for the tick, its runners, and Pi. Same for scheduled and manual runs. */
  env: Record<string, string>;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const string = (value: string) => `<string>${escape(value)}</string>`;

export function renderPlist(config: AgentConfig): string {
  const log = join(config.dir, "logs", "dispatch.log");
  const env = Object.entries(config.env).map(([key, value]) => `      <key>${escape(key)}</key>${string(value)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>${string(LABEL)}
    <key>ProgramArguments</key>
    <array>${string(config.node)}${string(config.dispatch)}${string("tick")}</array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>WorkingDirectory</key>${string(config.dir)}
    <!-- launchd skips intervals while asleep; the dispatcher finds missed slots itself. -->
    <key>StartInterval</key><integer>60</integer>
    <!-- Tick at login too, so a slot missed while the Mac was off is caught up right away. -->
    <key>RunAtLoad</key><true/>
    <!-- The tick exits while its runners continue; do not kill them with its process group. -->
    <key>AbandonProcessGroup</key><true/>
    <key>StandardOutPath</key>${string(log)}
    <key>StandardErrorPath</key>${string(log)}
  </dict>
</plist>
`;
}

async function loaded(): Promise<boolean> {
  try { await run("launchctl", ["print", `${domain()}/${LABEL}`]); return true; } catch { return false; }
}

async function bootstrap(): Promise<void> {
  // bootout returns before the old instance is fully gone; bootstrap then fails with EIO for a moment.
  for (let attempt = 0; ; attempt++) {
    try { await run("launchctl", ["bootstrap", domain(), plistPath()]); return; } catch (error) {
      if (attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function bootout(): Promise<void> {
  try { await run("launchctl", ["bootout", `${domain()}/${LABEL}`]); } catch { /* not loaded */ }
}

const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Whether an installed plist still points at existing files: node, dispatch.ts and the Pi CLI. */
export function plistIntact(content: string): boolean {
  const program = /<key>ProgramArguments<\/key>\s*<array><string>([^<]*)<\/string><string>([^<]*)<\/string>/.exec(content);
  const pi = /<key>PI_SCHEDULE_PI<\/key><string>([^<]*)<\/string>/.exec(content);
  if (!program || !pi) return false;
  let piArgv: unknown;
  try { piArgv = JSON.parse(unescape(pi[1])); } catch { return false; }
  const paths = [program[1], program[2], ...(Array.isArray(piArgv) ? piArgv : [""])].map((path) => unescape(String(path)));
  return paths.every((path) => existsSync(path));
}

/**
 * Make sure launchd has a working agent loaded. With `rewrite`, the plist is replaced whenever it
 * differs from this Pi's paths; without it, an intact plist is kept. Pi windows started under
 * different node installs would otherwise rewrite it on every startup.
 */
export async function ensureAgent(config: AgentConfig, { rewrite }: { rewrite: boolean }): Promise<"installed" | "updated" | "unchanged"> {
  mkdirSync(join(config.dir, "logs"), { recursive: true });
  const content = renderPlist(config);
  let current: string | undefined;
  try { current = readFileSync(plistPath(), "utf8"); } catch { /* not installed */ }
  if (current === content || (!rewrite && current !== undefined && plistIntact(current))) {
    if (await loaded()) return "unchanged";
    await bootstrap();
    return "installed";
  }
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(), content);
  await bootout();
  await bootstrap();
  return current === undefined ? "installed" : "updated";
}

export async function removeAgent(): Promise<void> {
  await bootout();
  rmSync(plistPath(), { force: true });
}

/** `launchctl print` lines worth showing: state, runs, last exit code. */
export async function agentStatus(): Promise<string> {
  try {
    const { stdout } = await run("launchctl", ["print", `${domain()}/${LABEL}`]);
    const wanted = /^\s*(state|runs|last exit code|run interval) = /;
    return stdout.split("\n").filter((line) => wanted.test(line)).map((line) => line.trim()).join(", ") || "loaded";
  } catch {
    return "not loaded";
  }
}
