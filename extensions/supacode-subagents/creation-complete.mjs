import * as fs from "node:fs";
import * as path from "node:path";

const [launchDir, jobId, launchNonce, exitCodeText] = process.argv.slice(2);
const exitCode = Number(exitCodeText);
if (!launchDir || !jobId || !launchNonce || !Number.isSafeInteger(exitCode)) {
  throw new Error("Invalid Supacode creation-completion arguments.");
}

const target = path.join(launchDir, "creation-complete.json");
const temporary = `${target}.${process.pid}.tmp`;
const handle = fs.openSync(temporary, "wx", 0o600);
try {
  fs.writeFileSync(handle, `${JSON.stringify({
    schemaVersion: 2,
    jobId,
    launchNonce,
    commandStarted: true,
    exitCode,
    completedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  fs.fsyncSync(handle);
} finally {
  fs.closeSync(handle);
}
fs.renameSync(temporary, target);
const directory = fs.openSync(launchDir, fs.constants.O_RDONLY);
try {
  fs.fsyncSync(directory);
} catch (error) {
  if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
} finally {
  fs.closeSync(directory);
}
