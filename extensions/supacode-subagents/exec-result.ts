import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PiExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface PiExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

function diagnostic(result: PiExecResult): string {
  const value = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  return value.length > 16_000
    ? `${value.slice(0, 16_000)}\n[diagnostic truncated]`
    : value;
}

/**
 * Pi 0.82 can report a signal-terminated child as code 0 with killed=true.
 * Every extension subprocess must pass through this guard before its exit code
 * is interpreted.
 */
export async function execRejectKilled(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  options: PiExecOptions = {},
): Promise<PiExecResult> {
  const result = await pi.exec(command, args, options);
  if (result.killed) {
    throw new Error(`${command} was terminated before settlement: ${diagnostic(result)}`);
  }
  return result;
}
