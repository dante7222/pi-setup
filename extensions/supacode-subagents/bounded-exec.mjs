import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

const CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const ARTIFACT_TRUNCATION_MARKER = Buffer.from("\n[artifact truncated at configured limit]\n");
const MIRROR_TRUNCATION_MARKER = Buffer.from("\n[terminal output truncated at configured limit]\n");

function safeTerminalText(value) {
  return value.replace(CONTROL_PATTERN, (character) => {
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    const codePoint = character.codePointAt(0);
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  });
}

function parseStreamConfiguration(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.mode !== "inherit" && value.mode !== "capture")) {
    throw new Error(`${label} configuration is invalid.`);
  }
  if (value.mode === "inherit") return { mode: "inherit" };
  if (typeof value.path !== "string" || !value.path ||
      !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 ||
      typeof value.append !== "boolean" ||
      (value.mirror !== false && value.mirror !== "stdout" && value.mirror !== "stderr")) {
    throw new Error(`${label} capture configuration is invalid.`);
  }
  return {
    mode: "capture",
    path: value.path,
    maxBytes: value.maxBytes,
    append: value.append,
    mirror: value.mirror,
  };
}

function utf8Prefix(buffer, maxBytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(buffer.length, maxBytes); end > 0; end--) {
    try {
      decoder.decode(buffer.subarray(0, end));
      return buffer.subarray(0, end);
    } catch {
      // Retry before a UTF-8 code point that straddles the byte limit.
    }
  }
  return Buffer.alloc(0);
}

async function writeMirrored(stream, value) {
  if (stream.write(value)) return;
  await once(stream, "drain");
}

async function consume(stream, configuration) {
  const handle = await fs.promises.open(
    configuration.path,
    configuration.append ? "a" : "w",
    0o600,
  );
  let storedBytes = configuration.append ? (await handle.stat()).size : 0;
  let truncated = false;
  const artifactMarker = utf8Prefix(ARTIFACT_TRUNCATION_MARKER, configuration.maxBytes);
  const markArtifactTruncated = async () => {
    if (truncated) return;
    truncated = true;
    const contentLimit = configuration.maxBytes - artifactMarker.length;
    if (storedBytes > contentLimit) {
      await handle.truncate(contentLimit);
      storedBytes = contentLimit;
    }
    if (artifactMarker.length > 0) {
      await handle.write(
        artifactMarker,
        0,
        artifactMarker.length,
        configuration.append ? null : contentLimit,
      );
      storedBytes += artifactMarker.length;
    }
  };
  if (storedBytes > configuration.maxBytes) await markArtifactTruncated();

  let mirroredBytes = 0;
  let mirrorTruncated = false;
  const mirrorMarker = utf8Prefix(MIRROR_TRUNCATION_MARKER, configuration.maxBytes);
  const mirrorContentLimit = configuration.maxBytes - mirrorMarker.length;
  const decoder = new StringDecoder("utf8");
  const consumeText = async (value) => {
    if (!value) return;
    const safe = safeTerminalText(value);
    const encoded = Buffer.from(safe);
    if (configuration.mirror && !mirrorTruncated) {
      const remainingMirrorContent = Math.max(0, mirrorContentLimit - mirroredBytes);
      const mirrorPrefix = utf8Prefix(encoded, remainingMirrorContent);
      if (mirrorPrefix.length > 0) {
        await writeMirrored(configuration.mirror === "stderr" ? process.stderr : process.stdout, mirrorPrefix);
        mirroredBytes += mirrorPrefix.length;
      }
      if (encoded.length > remainingMirrorContent) {
        if (mirrorMarker.length > 0) {
          await writeMirrored(configuration.mirror === "stderr" ? process.stderr : process.stdout, mirrorMarker);
          mirroredBytes += mirrorMarker.length;
        }
        mirrorTruncated = true;
      }
    }
    const remaining = Math.max(0, configuration.maxBytes - storedBytes);
    if (remaining > 0) {
      const prefix = utf8Prefix(encoded, remaining);
      if (prefix.length > 0) {
        await handle.write(prefix);
        storedBytes += prefix.length;
      }
    }
    if (encoded.length > remaining) await markArtifactTruncated();
  };
  try {
    for await (const chunk of stream) await consumeText(decoder.write(chunk));
    await consumeText(decoder.end());
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  const separator = process.argv.indexOf("--", 3);
  if (separator < 0 || separator === process.argv.length - 1) {
    throw new Error("Usage: bounded-exec.mjs '<config-json>' -- <command> [args...]");
  }
  const rawConfiguration = JSON.parse(process.argv[2]);
  if (!rawConfiguration || typeof rawConfiguration !== "object" || Array.isArray(rawConfiguration)) {
    throw new Error("Bounded-exec configuration is invalid.");
  }
  const stdout = parseStreamConfiguration(rawConfiguration.stdout, "stdout");
  const stderr = parseStreamConfiguration(rawConfiguration.stderr, "stderr");
  const command = process.argv[separator + 1];
  const args = process.argv.slice(separator + 2);

  const child = spawn(command, args, {
    stdio: [
      "inherit",
      stdout.mode === "inherit" ? "inherit" : "pipe",
      stderr.mode === "inherit" ? "inherit" : "pipe",
    ],
  });
  const childError = new Promise((_, reject) => child.once("error", reject));
  const close = once(child, "close");
  const consumers = [];
  if (stdout.mode === "capture") {
    consumers.push(consume(child.stdout, stdout));
  }
  if (stderr.mode === "capture") {
    consumers.push(consume(child.stderr, stderr));
  }

  const consumerCompletion = Promise.all(consumers);
  const consumerFailure = consumerCompletion.then(
    () => new Promise(() => undefined),
    (error) => Promise.reject(error),
  );
  let closeResult;
  try {
    closeResult = await Promise.race([close, childError, consumerFailure]);
    await consumerCompletion;
  } catch (error) {
    child.kill("SIGTERM");
    await close.catch(() => undefined);
    throw error;
  }
  const [code, signal] = closeResult;
  if (typeof code === "number") {
    process.exitCode = code;
    return;
  }
  process.stderr.write(`Command terminated by ${signal ?? "an unknown signal"}.\n`);
  process.exitCode = 74;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`bounded-exec: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 74;
}
