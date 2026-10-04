import { spawn } from "node:child_process";
import { closeSync, existsSync } from "node:fs";
import { Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { constants } from "node:os";
import { atomic, json } from "../core.ts";
import { bootIdentity, identityAlive, processIdentity, type ProcessIdentity } from "../identity.ts";
import { ProcessTree, type ProcessEvidence } from "../process-tree.ts";

export interface ShellRequest {
  coordinator: ProcessIdentity;
  conversationId: string;
  command: string;
  cwd: string;
  timeout: number;
}
interface Claim { identity?: ProcessIdentity; fenced?: true }
interface Execution { boot: string; tree: ProcessEvidence }
export interface ShellAck {
  verified: true;
  exitCode: number;
  error?: { code: "aborted" | "timeout" | "spawn_error" | "unknown"; message: string };
}

/** Persist discovery before every kill; successful delivery is not an exit proof. */
export async function stopTree(directory: string, tree: ProcessTree, boot: string): Promise<void> {
  const deadline = Date.now() + 2000;
  do {
    await tree.refresh();
    await atomic(join(directory, "execution.json"), { boot, tree: await tree.evidence() });
    if (await tree.signal("SIGKILL") === 0) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Shell cleanup unverified: ${directory}`);
}

/** Caller holds the host directory's single-owner lease; never reruns a command. */
export async function recoverExecution(directory: string): Promise<ShellAck> {
  const ackPath = join(directory, "shutdown.json");
  const saved = await json<ShellAck>(ackPath);
  if (saved?.verified === true) return saved;
  await atomic(join(directory, "cancel.json"), {});
  // This same immutable claim fences a supervisor delayed before startup.
  await atomic(join(directory, "supervisor.json"), { fenced: true }, true);
  const claim = await json<Claim>(join(directory, "supervisor.json"));
  if (!claim || (!claim.identity && !claim.fenced)) throw new Error(`Missing shell supervisor identity: ${directory}`);
  if (claim.identity) {
    const deadline = Date.now() + 600;
    while (await identityAlive(claim.identity)) {
      const ack = await json<ShellAck>(ackPath);
      if (ack?.verified === true) return ack;
      if (Date.now() >= deadline) break;
      await delay(25);
    }
    // Stop the only journal writer before reading its final evidence. Identity is
    // revalidated immediately before signaling; never trust a saved numeric PID.
    if (await identityAlive(claim.identity)) {
      try { process.kill(claim.identity.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const deathDeadline = Date.now() + 1000;
    while (await identityAlive(claim.identity)) {
      if (Date.now() >= deathDeadline) throw new Error(`Shell supervisor death unverified: ${directory}`);
      await delay(25);
    }
  }
  const ack = await json<ShellAck>(ackPath);
  if (ack?.verified === true) return ack;
  const execution = await json<Execution>(join(directory, "execution.json"));
  const spawning = await json<{ boot: string }>(join(directory, "spawning.json"));
  const boot = await bootIdentity();
  if (execution) {
    if (!execution.boot) throw new Error(`Missing shell boot evidence: ${directory}`);
    if (execution.boot === boot) await stopTree(directory, ProcessTree.restore(execution.tree), boot);
  } else if (spawning?.boot === boot || (spawning && !spawning.boot)) {
    // A crash between spawn and discovery cannot authorize a PID kill or a
    // success acknowledgement. The unreleased shell's stdin gate closes on death.
    throw new Error(`Shell ownership evidence missing; cleanup unverified: ${directory}`);
  }
  const recovered: ShellAck = { verified: true, exitCode: 1, error: { code: "aborted", message: "Shell stopped during recovery" } };
  await atomic(ackPath, recovered, true);
  return recovered;
}

async function supervise(directory: string): Promise<void> {
  process.umask(0o077);
  const request = await json<ShellRequest>(join(directory, "request.json"));
  if (!request) throw new Error("Missing shell request");
  const identity = await processIdentity();
  if (!identity) throw new Error("Cannot establish shell supervisor identity");
  if (!await atomic(join(directory, "supervisor.json"), { identity }, true)) return;
  let interrupted = false;
  let outputError: Error | undefined;
  const interrupt = () => { interrupted = true; };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, interrupt);
  process.stdin.on("end", interrupt);
  process.stdin.on("error", interrupt);
  process.stdin.resume();
  process.stdout.on("error", (error: Error) => {
    outputError = error; interrupted = true;
    child?.stdout?.resume(); child?.stderr?.resume();
  });
  let tree: ProcessTree | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited = false;
  let exitCode = 1;
  let failure: ShellAck["error"];
  try {
    if (existsSync(join(directory, "cancel.json")) || !await identityAlive(request.coordinator)) {
      failure = { code: "aborted", message: "Coordinator ended before shell startup" };
    } else {
      await atomic(join(directory, "spawning.json"), { boot: identity.boot }, true);
      // No command can run before discovery is journalled. A supervisor dying
      // inside spawn closes this pipe; Bash exits instead of executing the task.
      // The gate itself gets a clean environment: BASH_ENV, exported functions,
      // loader variables, etc. must not execute caller code before ownership is
      // persisted. Restore the complete requested environment only AFTER go.
      child = spawn("/bin/bash", ["--noprofile", "--norc", "-p", "-c", 'IFS= read -r gate || exit 1; [ "$gate" = go ] || exit 1; exec "$@"', "durable-shell", process.execPath, "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(import.meta.url), directory, "shell"], {
        // Pass the anonymous environment FD through without reading it here.
        // Bash preserves FD 3 across exec; only the post-gate helper consumes it.
        cwd: request.cwd, env: { PATH: "/usr/bin:/bin", PI_HERDR_WORKER: "1", PI_HERDR_GROUP: "none" }, detached: true, stdio: ["pipe", "pipe", "pipe", 3],
      });
      child.on("exit", (code, signal) => {
        exited = true;
        exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
      });
      child.on("error", (error) => { exited = true; failure = { code: "spawn_error", message: error.message }; });
      child.stdin?.on("error", (error) => { if (!exited) failure = { code: "spawn_error", message: error.message }; });
      const streams = [child.stdout, child.stderr];
      streams.forEach((stream, index) => {
        stream?.on("error", (error) => { outputError = error; });
        stream?.on("data", (chunk: Buffer) => {
          if (outputError) return;
          // Each pipe frame is bounded by Node's stream high-water mark. Pausing
          // BOTH streams propagates slow caller/disk backpressure to the shell.
          if (!process.stdout.write(`${index}:${chunk.toString("base64")}\n`)) {
            streams.forEach((pipe) => pipe?.pause());
          }
        });
      });
      process.stdout.on("drain", () => streams.forEach((pipe) => pipe?.resume()));
      if (!child.pid) {
        await delay(0);
        throw new Error(failure?.message || "Shell spawn failed");
      }
      tree = new ProcessTree(child.pid);
      await tree.refresh();
      await atomic(join(directory, "execution.json"), { boot: identity.boot, tree: await tree.evidence() });
      const deadline = Date.now() + request.timeout * 1000;
      if (!interrupted && !existsSync(join(directory, "cancel.json")) && await identityAlive(request.coordinator)) child.stdin?.end("go\n");
      else interrupted = true;
      while (!exited) {
        if (interrupted || existsSync(join(directory, "cancel.json")) || !await identityAlive(request.coordinator)) {
          failure = { code: "aborted", message: "aborted" }; break;
        }
        if (Date.now() >= deadline) { failure = { code: "timeout", message: `timeout:${request.timeout}` }; break; }
        if (failure || outputError) break;
        await tree.refresh();
        await atomic(join(directory, "execution.json"), { boot: identity.boot, tree: await tree.evidence() });
        await delay(50);
      }
      if (tree) await stopTree(directory, tree, identity.boot);
      const reapDeadline = Date.now() + 1000;
      while (!exited) {
        if (Date.now() >= reapDeadline) throw new Error("Shell child was not reaped");
        await delay(10);
      }
      // Descendant pipe holders have been killed; allow the final data/end events.
      const drainDeadline = Date.now() + 1000;
      while (streams.some((stream) => stream && !stream.readableEnded && !stream.destroyed)) {
        if (Date.now() >= drainDeadline) throw new Error("Shell output did not drain");
        await delay(10);
      }
    }
    if (outputError) failure = { code: "unknown", message: outputError.message };
    await atomic(join(directory, "shutdown.json"), { verified: true, exitCode, ...(failure ? { error: failure } : {}) }, true);
  } catch (error) {
    // Keep unresolved evidence for startup recovery; never publish a false ack.
    if (tree) await stopTree(directory, tree, identity.boot).catch(() => {});
    await atomic(join(directory, "failure.json"), { message: String(error) });
    process.exitCode = 1;
  } finally {
    child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
    process.stdin.destroy();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(signal, interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Shell supervisor directory required");
  if (process.argv[3] === "shell") {
    // This group leader only starts after the supervisor journals and opens its
    // stdin gate. Keep environment secrets off argv and keep Bash in the already
    // owned process group. The supervisor also reaps this leader before its ack.
    const environmentPipe = new Socket({ fd: 3, readable: true, writable: false });
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of environmentPipe) {
        const data = chunk as Buffer;
        bytes += data.length;
        if (bytes > 1024 * 1024) throw new Error("Oversized shell environment");
        chunks.push(data);
      }
      // Parse errors can contain input snippets, so never report their messages.
      const env: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("Invalid shell environment");
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || key.includes("\0") || key.includes("=") || value.includes("\0")) throw new Error("Invalid shell environment");
      }
      const request = await json<ShellRequest>(join(directory, "request.json"));
      if (!request) throw new Error("Missing gated shell request");
      if (!existsSync(join(directory, "cancel.json"))) {
        const shell = spawn("/bin/bash", ["-c", request.command], {
          cwd: request.cwd,
          env: { ...env as Record<string, string>, PI_HERDR_WORKER: "1", PI_HERDR_GROUP: "none" },
          stdio: ["ignore", "inherit", "inherit"],
        });
        shell.on("error", () => { process.exitCode = 1; });
        shell.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1); });
      } else process.exitCode = 1;
    } catch {
      // Environment payloads are private even on malformed input / pipe errors.
      process.stderr.write("Private shell environment or startup failed\n");
      process.exitCode = 1;
    } finally {
      environmentPipe.destroy();
    }
  } else {
    try { await supervise(directory); }
    finally { closeSync(3); }
  }
}
