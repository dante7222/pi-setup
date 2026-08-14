import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_EDITOR_OUTPUT_CHARS = 64 * 1024;
const ZED_LAUNCH_SCRIPT = String.raw`
IFS= read -r ready || exit 1
exec zed --wait "$1"
`;

export class SessionGroupEditorError extends Error {
  readonly path: string;
  readonly exitCode: number | undefined;

  constructor(path: string, message: string, exitCode?: number) {
    super(message);
    this.name = "SessionGroupEditorError";
    this.path = path;
    this.exitCode = exitCode;
  }
}

export type SessionGroupEditorPidHandler = (
  pid: number | null,
) => Promise<void> | void;

export async function editSessionGroupContextInZed(
  _pi: ExtensionAPI,
  path: string,
  onEditorPid?: SessionGroupEditorPidHandler,
): Promise<void> {
  // The shell waits for a one-line gate before exec replaces it with Zed. This
  // lets the lock record its PID first, while exec preserves that PID for the
  // full `zed --wait` lifetime even if Pi exits.
  const launcher = spawn(
    "/bin/sh",
    ["-c", ZED_LAUNCH_SCRIPT, "session-group-zed", path],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  launcher.stdout?.setEncoding("utf8");
  launcher.stderr?.setEncoding("utf8");
  launcher.stdout?.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-MAX_EDITOR_OUTPUT_CHARS);
  });
  launcher.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_EDITOR_OUTPUT_CHARS);
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      launcher.once("error", rejectExit);
      launcher.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );

  if (launcher.pid === undefined || launcher.stdin === null) {
    launcher.kill();
    await exit.catch(() => undefined);
    throw new SessionGroupEditorError(path, `Could not start the Zed launcher for ${path}.`);
  }

  try {
    await onEditorPid?.(launcher.pid);
    launcher.stdin.end("start\n");
  } catch (error) {
    launcher.kill();
    await exit.catch(() => undefined);
    throw error;
  }

  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await exit;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionGroupEditorError(
      path,
      `Could not launch Zed for ${path}: ${detail}`,
    );
  } finally {
    await onEditorPid?.(null);
  }

  if (result.code !== 0) {
    const detail = (stderr || stdout).trim();
    const termination =
      result.code === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.code}`;
    throw new SessionGroupEditorError(
      path,
      `Zed exited with ${termination} while editing ${path}${detail ? `: ${detail}` : "."}`,
      result.code ?? undefined,
    );
  }
}
