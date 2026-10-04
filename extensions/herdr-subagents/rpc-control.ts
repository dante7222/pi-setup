import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { atomic, json } from "./core.ts";

interface ControlRequest { id: string; kind: "steer" | "follow_up"; message: string }
export interface ControlReply { state: "accepted" | "rejected" | "uncertain"; error?: string; disposition?: string }
interface Pending { command: string; resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }

/** Private file mailbox. Attempt publication precedes pipe I/O; an ambiguous attempt is never replayed. */
export class RpcControl {
  private readonly directory: string;
  private readonly input: Writable;
  private readonly fail: (error: unknown) => void;
  private readonly onClose: () => void;
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly operations = new Set<Promise<void>>();
  private scanning: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private initialComplete = false;
  private responsive = false;
  private probingUI = false;
  private active = false;
  private settled = false;
  private closing: string | undefined;
  private finalizing = false;
  private generation = 0;
  private stopped: Promise<void> | undefined;
  private ended = false;
  private finalVerified = false;

  constructor(directory: string, input: Writable, fail: (error: unknown) => void, onClose: () => void = () => {}) {
    this.directory = join(directory, "control");
    this.input = input;
    this.fail = fail;
    this.onClose = onClose;
  }

  async start(message: string): Promise<void> {
    const response = await this.request({ type: "prompt", message }, 0);
    this.initialComplete = true;
    if (!response.success) throw new Error(`RPC prompt rejected: ${response.error}`);
    if (response.command !== "prompt" || !response.data || !["started", "queued", "handled"].includes(response.data.disposition)) throw new Error("Invalid RPC prompt response.");
    if (response.data.disposition === "handled" && !this.active && !this.settled) {
      throw new Error("RPC prompt was handled without starting an agent run; no final report.");
    }
    this.maybeFinalize();
  }

  event(event: Record<string, unknown>): void {
    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      this.responsive = true;
      if (event.command !== pending.command || typeof event.success !== "boolean") pending.reject(new Error("Mismatched RPC response."));
      else pending.resolve(event as unknown as RpcResponse);
    } else if (event.type === "extension_ui_request" && typeof event.id === "string" && ["select", "confirm", "input", "editor"].includes(String(event.method))) {
      void this.send({ type: "extension_ui_response", id: event.id, cancelled: true }).catch(this.fail);
      if (!this.responsive && !this.probingUI) {
        this.probingUI = true;
        // Pi 1.0 binds extensions before installing its stdin reader. A startup
        // dialog therefore cannot consume even its cancellation reply. Probe the
        // reader and fail promptly instead of hanging until the task deadline.
        void this.request({ type: "get_state" }, 1500).catch(() => {
          this.fail(new Error("RPC startup dialog could not be cancelled: Pi's stdin reader is not responsive during extension binding. Disable the interactive startup hook for workers."));
        });
      }
    } else if (event.type === "agent_start") {
      this.generation++;
      this.active = true;
      this.settled = false;
    } else if (event.type === "agent_settled") {
      this.generation++;
      this.active = false;
      this.settled = true;
      // This is an admission boundary, not permission to drop outstanding writes.
      this.closing ??= "Agent settled; control was not submitted before settlement.";
      this.maybeFinalize();
    }
  }

  poll(): Promise<void> {
    const next = this.scanning.then(() => this.scan());
    this.scanning = next.catch(() => {});
    return next;
  }

  private async scan(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
      if (this.seen.has(name)) continue;
      this.seen.add(name);
      const base = join(this.directory, name.slice(0, -5));
      if (await json<ControlReply>(`${base}.reply.json`)) continue;
      let request: ControlRequest | undefined;
      try { request = await json<ControlRequest>(join(this.directory, name)); }
      catch { /* Reject invalid JSON with a paired reply, not a supervisor crash. */ }
      if (!request || typeof request.id !== "string" || !request.id || createHash("sha256").update(request.id).digest("hex") !== name.slice(0, -5) || !["steer", "follow_up"].includes(request.kind) || typeof request.message !== "string" || !request.message.trim()) {
        await atomic(`${base}.reply.json`, { state: "rejected", error: "Invalid control request or request-id filename." });
        continue;
      }
      if (await json<unknown>(`${base}.attempted.json`)) {
        await atomic(`${base}.reply.json`, { state: "uncertain", error: "Control was already attempted; it will not be replayed." });
        continue;
      }
      if (this.closing) {
        await atomic(`${base}.reply.json`, { state: "rejected", error: this.closing });
        continue;
      }
      if (!await atomic(`${base}.attempted.json`, { id: request.id, kind: request.kind, attemptedAt: Date.now() }, true)) {
        await atomic(`${base}.reply.json`, { state: "uncertain", error: "Control was already attempted; it will not be replayed." });
        continue;
      }
      // Settlement/cancellation can arrive during the durable attempt write.
      if (this.closing) {
        await atomic(`${base}.reply.json`, { state: "rejected", error: this.closing });
        continue;
      }
      const operation = this.request({ type: request.kind, message: request.message }, 5000).then(async (response) => {
        if (!response.success) {
          await atomic(`${base}.reply.json`, { state: "rejected", error: response.error });
          return;
        }
        if (response.command !== "steer" && response.command !== "follow_up") throw new Error("Invalid control response.");
        const disposition = response.data?.disposition;
        if (disposition !== "queued" && disposition !== "handled") throw new Error("Invalid control disposition.");
        if (disposition === "queued") this.queued.add(base);
        await atomic(`${base}.reply.json`, { state: "accepted", disposition });
      }).catch(async (error: unknown) => {
        await atomic(`${base}.reply.json`, { state: "uncertain", error: String(error) });
        this.fail(error);
      });
      this.operations.add(operation);
      void operation.finally(() => this.operations.delete(operation)).catch(this.fail);
    }
  }

  private maybeFinalize(): void {
    if (!this.settled || !this.initialComplete || this.finalizing || this.stopped || this.ended) return;
    this.finalizing = true;
    const generation = this.generation;
    void (async () => {
      await this.poll();
      await Promise.all([...this.operations]);
      if (this.stopped || this.ended) return;
      // A steer accepted concurrently with settlement can be stranded in Pi's
      // idle queue. Confirm it is empty rather than silently closing over it.
      const response = await this.request({ type: "get_state" }, 1000);
      if (!response.success) throw new Error(`RPC final state rejected: ${response.error}`);
      if (response.command !== "get_state" || !response.data) throw new Error("Invalid RPC final state.");
      if (response.data.isStreaming || response.data.isCompacting || !this.settled || generation !== this.generation) return;
      if (response.data.pendingMessageCount !== 0) {
        await this.markUncertain("Pi settled with queued controls still pending; delivery is not confirmed.");
        throw new Error("Pi settled with queued controls still pending.");
      }
      await this.closeMailbox("Agent settled; RPC input is closed.");
      await this.writes;
      if (this.stopped || this.ended || !this.settled || generation !== this.generation) return;
      this.finalVerified = true;
      this.ended = true;
      this.input.end();
      this.onClose();
    })().catch(this.fail).finally(() => {
      this.finalizing = false;
      if (generation !== this.generation) this.maybeFinalize();
    });
  }

  /** Grace precedes the supervisor's independent TERM/KILL escalation. */
  abort(): Promise<void> {
    return this.stopped ??= (async () => {
      this.closing = "Worker stopped; control was not delivered.";
      if (!this.ended) {
        // Abort alone can continue queued work. Always clear first, even when
        // either response is lost; request deadlines bound the graceful phase.
        await this.request({ type: "clear_queue" }, 350).catch(() => {});
        await this.request({ type: "abort" }, 350).catch(() => {});
        this.ended = true;
        this.input.end();
      }
    })();
  }

  async finish(reason = "RPC process exited; control delivery is not confirmed."): Promise<void> {
    this.ended = true;
    this.closing = reason;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    await this.poll();
    await Promise.all([...this.operations]);
    if (!this.finalVerified || this.stopped) await this.markUncertain(reason);
    await this.closeMailbox(reason);
  }

  private async markUncertain(error: string): Promise<void> {
    for (const base of this.queued) await atomic(`${base}.reply.json`, { state: "uncertain", disposition: "queued", error });
  }

  private async closeMailbox(reason: string): Promise<void> {
    this.closing = reason;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomic(join(this.directory, "closed.json"), { error: reason });
    await this.poll();
  }

  private request(command: RpcCommand, timeout: number): Promise<RpcResponse> {
    const id = randomUUID();
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${command.type} response timed out; delivery is uncertain.`));
      }, timeout) : undefined;
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      void this.send({ ...command, id }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private send(record: RpcCommand | RpcExtensionUIResponse): Promise<void> {
    const next = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.ended || this.input.destroyed || this.input.writableEnded) { reject(new Error("RPC input is closed.")); return; }
      // Waiting for the write callback serializes records and honors backpressure.
      this.input.write(`${JSON.stringify(record)}\n`, (error) => error ? reject(error) : resolve());
    }));
    this.writes = next.catch(() => {});
    return next;
  }
}
