import { homedir } from "node:os";
import { resolve } from "node:path";

export function resolvePermissionConfigPath(
  configuredPath: string | undefined,
  cwd: string,
  home = homedir(),
): string | undefined {
  const configured = configuredPath?.trim();
  if (!configured) return undefined;
  const expanded = configured === "~"
    ? home
    : configured.startsWith("~/") || configured.startsWith("~\\")
      ? home + configured.slice(1)
      : configured;
  return resolve(cwd, expanded);
}
