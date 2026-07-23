import { execFile } from "node:child_process";

const PS_TIMEOUT_MS = 2000;

export interface ProcessIdentity {
  pid: number;
  startSignature: string;
  processGroup: number;
  command: string;
  launchNonce: string;
}

export type ProcessIdentityState = "alive" | "missing" | "mismatch" | "unknown";

function psField(pid: number, field: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", `${field}=`, "-p", String(pid)],
      { encoding: "utf8", timeout: PS_TIMEOUT_MS },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
    );
  });
}

export async function captureProcessIdentity(
  pid: number,
  launchNonce: string,
  expectedProcessGroup?: number,
): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const [startSignature, processGroupText, command] = await Promise.all([
    psField(pid, "lstart"),
    psField(pid, "pgid"),
    psField(pid, "command"),
  ]);
  const processGroup = Number(processGroupText);
  if (
    !startSignature || !Number.isSafeInteger(processGroup) || processGroup <= 1 ||
    (expectedProcessGroup !== undefined && processGroup !== expectedProcessGroup)
  ) return undefined;
  return {
    pid,
    startSignature,
    processGroup,
    command: command ?? "",
    launchNonce,
  };
}

export async function inspectProcessIdentity(identity: ProcessIdentity): Promise<ProcessIdentityState> {
  const current = await captureProcessIdentity(identity.pid, identity.launchNonce);
  if (!current) {
    try {
      process.kill(identity.pid, 0);
      return "unknown";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? "missing" : "unknown";
    }
  }
  return current.startSignature === identity.startSignature &&
      current.processGroup === identity.processGroup
    ? "alive"
    : "mismatch";
}

export async function currentProcessGroup(): Promise<number | undefined> {
  const value = Number(await psField(process.pid, "pgid"));
  return Number.isSafeInteger(value) && value > 1 ? value : undefined;
}
