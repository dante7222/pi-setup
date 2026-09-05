import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  /** Locale-independent ps lstart, normalized to single spaces. */
  start: string;
}
export type ProcessSnapshot = readonly ProcessEntry[];

/** Only process identities/relationships: never commands, arguments or environment. */
export async function snapshotProcesses(): Promise<ProcessSnapshot> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("ProcessTree requires macOS or Linux ps.");
  }
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
    env: { LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split("\n").filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
    // A partial/unrecognized snapshot must not silently discard ownership.
    if (!match) throw new Error("Unrecognized ps process identity row.");
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], start: match[5].replace(/\s+/g, " ") };
  });
}

/**
 * Best-effort cleanup of an owned, preferably detached Pi process, not a sandbox.
 * Refresh immediately after spawn, periodically, and before finalization. signal()
 * always takes another live snapshot; it sends once, without waiting for exit or
 * escalating. The supervisor owns the TERM/grace/KILL policy, even after Pi exits.
 * The first snapshot must contain the root; otherwise this instance fails closed
 * and never attaches to that numeric PID. No constructor I/O or background timers.
 *
 * Optional normal-exit handoff: in Pi's awaited session_shutdown hook, atomically
 * publish await snapshotProcesses() to a private per-job file. Before cleanup the
 * supervisor calls await tree.refresh(savedSnapshot), then tree.signal(...).
 * Supplied snapshots are TRUSTED historical discovery evidence, never authority
 * to signal without live revalidation. Use only the current job's hook output.
 *
 * lstart has second precision; ps and kill are not atomic. Observed PID/PGID reuse
 * is rejected, but reuse within that precision/window cannot be ruled out. A
 * leaderless group is retained until observed empty or its leader PID is reused;
 * an entire group disappearing and being recreated between samples is ambiguous.
 * Truly daemonized/double-fork children escaping ancestry AND owned groups between
 * samples cannot be guaranteed, including before the shutdown hook runs.
 */
export class ProcessTree {
  private readonly pid: number;
  private initialized = false;
  private rootStart: string | undefined;
  private readonly processes = new Map<number, string>();
  // Only claim a whole group when its leader was itself an owned process.
  // Unlike PPID, the PGID survives leader exit and reparenting of its members.
  private readonly groups = new Map<number, string>();
  private pending: Promise<void> = Promise.resolve();

  constructor(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff || pid === process.pid) {
      throw new Error("ProcessTree requires an owned child PID greater than 1.");
    }
    this.pid = pid;
  }

  /** With an argument, merge a trusted pre-exit snapshot rather than sample ps. */
  async refresh(snapshot?: ProcessSnapshot): Promise<void> {
    return this.enqueue(async () => this.observe(snapshot ?? await snapshotProcesses(), snapshot !== undefined));
  }

  async signal(signal: NodeJS.Signals): Promise<number> {
    return this.enqueue(async () => {
      // Never fall back to blind numeric/group kills if ps fails.
      const snapshot = await snapshotProcesses();
      this.observe(snapshot, false);
      const selfGroup = snapshot.find((entry) => entry.pid === process.pid)?.pgid;
      const targets = new Set<number>();
      // macOS returns EPERM for zombie-only groups. Zombies cannot execute and
      // must be reaped by their parent, not signaled. Keep their ancestry above.
      const live = snapshot.filter((entry) => !/^[ZX]/.test(entry.state));
      // Newest discovered groups first; avoid duplicate delivery to group members.
      for (const [pgid] of [...this.groups].reverse()) {
        if (pgid > 1 && pgid !== selfGroup && live.some((entry) => entry.pgid === pgid)) targets.add(-pgid);
      }
      for (const entry of [...live].reverse()) {
        if (entry.pid > 1 && entry.pid !== process.pid && this.processes.get(entry.pid) === entry.start && !targets.has(-entry.pgid)) {
          targets.add(entry.pid);
        }
      }
      const failures: string[] = [];
      for (const target of targets) {
        try { process.kill(target, signal); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(`${target}: ${String(error)}`);
        }
      }
      if (failures.length) throw new AggregateError(failures, `Could not signal all owned processes: ${failures.join("; ")}`);
      return targets.size;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    // Serialize polling, shutdown snapshots and signaling; an error is returned to
    // its caller but must not poison a later cleanup attempt.
    this.pending = next.then(() => {}, () => {});
    return next;
  }

  private observe(snapshot: ProcessSnapshot, historical: boolean): void {
    const rows = new Map(snapshot.map((entry) => [entry.pid, entry]));
    if (!this.initialized) {
      this.rootStart = rows.get(this.pid)?.start;
      this.initialized = true;
    }
    // Once missed/exited, never attach to a later occupant of the root PID.
    if (!this.rootStart) return;
    if (historical && rows.get(this.pid)?.start !== this.rootStart) {
      throw new Error("Process snapshot does not match the owned root identity.");
    }
    const owned = new Map<number, ProcessEntry>();
    for (const [pid, start] of this.processes) {
      const entry = rows.get(pid);
      if (entry?.start === start) owned.set(pid, entry);
    }
    const root = rows.get(this.pid);
    if (root?.start === this.rootStart) owned.set(root.pid, root);

    const members = new Map<number, ProcessEntry[]>();
    const children = new Map<number, ProcessEntry[]>();
    for (const entry of snapshot) {
      const group = members.get(entry.pgid) ?? [];
      group.push(entry);
      members.set(entry.pgid, group);
      const siblings = children.get(entry.ppid) ?? [];
      siblings.push(entry);
      children.set(entry.ppid, siblings);
    }
    // Historical snapshots may add discoveries, but must not retire live ownership
    // based on old absences. Only a fresh snapshot can retire processes or groups.
    for (const [pgid, start] of this.groups) {
      const leader = rows.get(pgid);
      if (!members.has(pgid) || (leader && leader.start !== start)) {
        if (!historical) this.groups.delete(pgid);
        continue;
      }
      for (const member of members.get(pgid) ?? []) owned.set(member.pid, member);
    }
    const queue = [...owned.values()];
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index];
      const related = [...(children.get(entry.pid) ?? [])];
      if (entry.pid === entry.pgid && entry.pid > 1) {
        this.groups.set(entry.pgid, entry.start);
        related.push(...(members.get(entry.pgid) ?? []));
      }
      for (const child of related) {
        if (child.pid <= 1 || child.pid === process.pid || owned.has(child.pid)) continue;
        owned.set(child.pid, child);
        queue.push(child);
      }
    }
    if (!historical) this.processes.clear();
    for (const entry of owned.values()) this.processes.set(entry.pid, entry.start);
  }
}
