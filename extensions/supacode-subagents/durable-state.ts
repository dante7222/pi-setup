import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close();
  }
}

export async function ensureDirectoryDurable(directory: string): Promise<void> {
  const missing: string[] = [];
  let cursor = path.resolve(directory);
  while (true) {
    try {
      const stat = await fs.promises.lstat(cursor);
      if (!stat.isDirectory()) throw new Error(`Metadata parent is not a directory: ${cursor}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const next of missing.reverse()) {
    try {
      await fs.promises.mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.promises.lstat(next);
      if (!stat.isDirectory()) throw error;
    }
    await syncDirectory(path.dirname(next));
  }
}

export async function durableAtomicWrite(
  filePath: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDirectoryDurable(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function durableAppendJsonLine(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDirectoryDurable(directory);
  const handle = await fs.promises.open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

export async function createExclusiveJson(filePath: string, value: unknown): Promise<boolean> {
  const directory = path.dirname(filePath);
  await ensureDirectoryDurable(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: fs.promises.FileHandle | undefined;
  let published = false;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.promises.link(temporaryPath, filePath);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (published) await syncDirectory(directory);
    return published;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (published) await syncDirectory(directory);
  }
}

export async function readJsonStrict<T>(filePath: string): Promise<T | undefined> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Corrupt JSON metadata at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
