import { resolve } from "node:path";

export function decodeSupacodeResourceId(value: string): string {
  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim();
  }
}

export function findSupacodePathId(listOutput: string, targetPath: string): string | undefined {
  const resolvedTarget = resolve(targetPath);
  return listOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((id) => id && resolve(decodeSupacodeResourceId(id)) === resolvedTarget);
}

export function sameSupacodeUuid(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
