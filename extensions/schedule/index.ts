// /schedule: run prompts later or on a schedule, driven only by the command (no tool, no prompt text).
//
// Two targets, each with a single executor so nothing runs twice:
// - session: lives in this Pi process; the prompt is sent into this conversation between turns.
//   Saved as a custom session entry (never sent to the model) and restored on reload or resume.
// - bg: lives in ~/.pi/agent/schedule/jobs.json; only the launchd dispatcher (dispatch.ts) runs it,
//   as a headless `pi -p` in a fresh saved session, even when Pi is closed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { claimMaxAge, openLog } from "./dispatch.ts";
import { agentStatus, ensureAgent, plistPath, removeAgent, type AgentConfig } from "./launchd.ts";
import { interpretSchedule } from "./interpret.ts";
import { describeSchedule, formatDuration, formatTime, nextRun, parseDuration, parseTiming, TIMING_HELP, UnknownTimingError, upcoming, type Schedule } from "./parse.ts";
import { forgetJob, readClaim, readJobs, readLastRunAt, readRuns, writeJobs, type BackgroundJob } from "./store.ts";

const ENTRY = "schedule-jobs";
const TICK_MS = 15_000;
/** A restored one-shot this overdue is dropped: its session was closed when it was due. */
const RESTORE_GRACE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_SEC = 30 * 60;
const INTERPRET_TIMEOUT_MS = 60_000;
const SUBCOMMANDS = ["list", "bg", "run", "rm", "pause", "resume", "log", "doctor"];
const ID_COMMANDS = new Set(["run", "rm", "pause", "resume", "log"]);
/** Passed to background runs. Everything else (API keys, tokens) stays out of the plist. */
const ENV_KEYS = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "PATH", "PI_CODING_AGENT_DIR"];
const USAGE = `Usage: /schedule [bg [--tools a,b] [--timeout 30m] [--no-catchup]] <timing> <prompt> | list | run|rm|pause|resume|log <id> | doctor\nTiming: ${TIMING_HELP}`;
const BG_OPTION = /^--(no-catchup|tools|timeout)(?:=|\s+|$)/;

interface SessionJob { id: string; prompt: string; schedule: Schedule; createdAt: number; paused?: boolean }
interface LiveJob extends SessionJob { nextAt?: number }

interface Row {
  id: string;
  target: "session" | "bg";
  prompt: string;
  schedule: Schedule;
  paused: boolean;
  state: string;
  bg?: BackgroundJob;
  lastSessionId?: string;
}

const newId = () => randomBytes(3).toString("hex");
const preview = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** "at 15:00" for one-shots, "every 2h, next 14:30" for recurring jobs. */
const scheduleText = (timing: Schedule, now: number) => {
  const next = nextRun(timing, now);
  return timing.kind === "once" || next === undefined ? describeSchedule(timing, now) : `${describeSchedule(timing, now)}, next ${formatTime(next, now)}`;
};
/**
 * A one-shot is finished once its slot has a run record and no runner holds it. The tick records the
 * slot before the runner starts, so lastRunAt alone would prune a job that has not run yet.
 */
function finished(dir: string, job: BackgroundJob): boolean {
  const { schedule: timing } = job;
  if (timing.kind !== "once" || readClaim(dir, job.id, claimMaxAge(job))) return false;
  return readRuns(dir, job.id).some((run) => run.slot !== undefined && run.slot >= timing.at);
}

function isSessionJob(value: unknown): value is SessionJob {
  const job = value as SessionJob | undefined;
  return typeof job?.id === "string" && typeof job.prompt === "string" && typeof job.schedule?.kind === "string";
}

/**
 * Latest snapshot in the whole session file, not only the current branch: jobs belong to the
 * session, and /tree navigation should not silently cancel them.
 */
function latestSnapshot(entries: readonly SessionEntry[]): SessionJob[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
    const jobs = (entry.data as { jobs?: unknown } | undefined)?.jobs;
    return Array.isArray(jobs) ? jobs.filter(isSessionJob) : [];
  }
  return [];
}

function agentConfig(dir: string): AgentConfig {
  if (!/^node(\.exe)?$/i.test(basename(process.execPath))) throw new Error("Background jobs need Pi running under node.");
  const script = process.argv[1];
  if (!script || !existsSync(script)) throw new Error("Cannot locate the Pi CLI script.");
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.PI_SCHEDULE_DIR = dir;
  env.PI_SCHEDULE_PI = JSON.stringify([process.execPath, script]);
  return { node: process.execPath, dispatch: fileURLToPath(new URL("./dispatch.ts", import.meta.url)), dir, env };
}

export default function schedule(pi: ExtensionAPI): void {
  // Scheduled runs and subagent workers load this package too; they must never schedule.
  if (process.env.PI_SCHEDULE_RUN || process.env.PI_SUBAGENT === "1") return;
  const dir = process.env.PI_SCHEDULE_DIR ?? join(getAgentDir(), "schedule");
  // PI_SCHEDULE_LAUNCHD=0 leaves launchd alone (tests, or managing the agent by hand).
  const manageAgent = process.env.PI_SCHEDULE_LAUNCHD !== "0";
  let jobs: LiveJob[] = [];
  let ctx: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;

  const notify = (text: string, type: "info" | "warning" | "error" = "info") => {
    try { ctx?.ui.notify(text, type); } catch { /* stale ctx */ }
  };
  const save = () => pi.appendEntry(ENTRY, { jobs: jobs.map(({ nextAt: _, ...job }) => job) });
  const showStatus = () => {
    try { if (ctx?.hasUI) ctx.ui.setStatus("schedule", jobs.length ? `schedule ${jobs.length}` : undefined); } catch { /* stale ctx */ }
  };
  const disarm = () => { clearInterval(timer); timer = undefined; };
  const changed = (persist = true) => {
    if (persist) save();
    showStatus();
    if (!jobs.length) disarm();
    else if (!timer) {
      timer = setInterval(tick, TICK_MS);
      timer.unref();
    }
  };

  const send = (job: LiveJob) => pi.sendUserMessage(job.prompt, { deliverAs: "followUp", expandPromptTemplates: true });

  /**
   * Fire at most one due job per tick, and only while idle: the prompt then starts its own turn
   * instead of being queued into a run that Esc would clear. A job that came due while busy or
   * asleep fires once, then moves to its next slot after now (no catch-up).
   */
  function tick(): void {
    const current = ctx;
    if (!current) return;
    try { if (!current.isIdle() || current.hasPendingMessages()) return; } catch { return; }
    // An exception escaping a timer would take the whole Pi window down.
    try {
      const now = Date.now();
      // Earliest due first, so a frequent job cannot starve an overdue one.
      const due = jobs.filter((job) => !job.paused && job.nextAt !== undefined && job.nextAt <= now).sort((a, b) => a.nextAt! - b.nextAt!)[0];
      if (!due) return;
      due.nextAt = nextRun(due.schedule, now);
      if (due.nextAt === undefined) {
        jobs = jobs.filter((job) => job !== due);
        changed();
      }
      send(due);
    } catch (error) {
      notify(`Schedule: ${message(error)}`, "error");
    }
  }

  // Background jobs ------------------------------------------------------------------------

  /**
   * Keep the LaunchAgent in step with the job store: loaded iff unfinished jobs remain.
   * `rewrite` points it at this Pi's node and CLI; startup only repairs a broken install.
   */
  const syncAgent = async (rewrite: boolean): Promise<string | undefined> => {
    if (!manageAgent) return undefined;
    const active = readJobs(dir).filter((job) => !finished(dir, job));
    if (!active.length) {
      if (existsSync(plistPath())) { await removeAgent(); return "launchd agent removed (no background jobs)"; }
      return undefined;
    }
    const result = await ensureAgent(agentConfig(dir), { rewrite });
    return result === "unchanged" ? undefined : `launchd agent ${result}`;
  };

  /** Writes go through here: finished one-shots are pruned (with their files) on every change. */
  const updateBackground = (update: (jobs: BackgroundJob[]) => BackgroundJob[]) => {
    const all = readJobs(dir);
    const done = all.filter((job) => finished(dir, job));
    writeJobs(dir, update(all.filter((job) => !done.includes(job))));
    for (const job of done) forgetJob(dir, job.id);
  };

  const runBackgroundNow = (id: string) => {
    const config = agentConfig(dir);
    const output = openLog(dir);
    // Same entry point, environment and log as a scheduled run, so "run now" is a faithful test.
    try {
      spawn(config.node, [config.dispatch, "run", id], { cwd: dir, detached: true, stdio: ["ignore", output, output], env: config.env }).unref();
    } finally {
      closeSync(output);
    }
  };

  // Listing ----------------------------------------------------------------------------------

  const rows = (): Row[] => {
    const now = Date.now();
    const session: Row[] = jobs.map((job) => ({
      id: job.id, target: "session", prompt: job.prompt, schedule: job.schedule, paused: !!job.paused,
      state: job.paused ? "paused" : job.nextAt === undefined ? "done" : job.nextAt <= now ? "due" : `next ${formatTime(job.nextAt, now)}`,
    }));
    let background: Row[] = [];
    try {
      background = readJobs(dir).map((job) => {
        const lastRunAt = readLastRunAt(dir, job.id);
        const last = readRuns(dir, job.id, 1)[0];
        let next: number | undefined;
        let invalid = false;
        // A job whose schedule cannot be computed still lists, so it can be removed.
        try { next = nextRun(job.schedule, Math.max(now, lastRunAt ?? 0)); } catch { invalid = true; }
        const state = readClaim(dir, job.id, claimMaxAge(job)) ? "running"
          : finished(dir, job) ? "done"
          : invalid ? "invalid schedule"
          : !job.enabled ? "paused"
          : next !== undefined ? `next ${formatTime(next, now)}` : "due";
        const lastText = last ? `, last ${last.status} ${formatTime(last.startedAt, now)}` : "";
        return { id: job.id, target: "bg", prompt: job.prompt, schedule: job.schedule, paused: !job.enabled, state: state + lastText, bg: job, lastSessionId: last?.sessionId };
      });
    } catch (error) {
      notify(`Cannot read ${join(dir, "jobs.json")}: ${message(error)}`, "error");
    }
    return [...session, ...background];
  };

  const label = (row: Row) => `${row.id}  ${row.target.padEnd(7)} ${describeSchedule(row.schedule)}  (${row.state})  ${preview(row.prompt, 50)}`;
  const listText = () => rows().map(label).join("\n") || "No scheduled jobs.";

  const find = (id: string | undefined): Row => {
    const row = rows().find((candidate) => candidate.id === id);
    if (!row) throw new Error(id ? `No scheduled job "${id}".` : "Missing job id.");
    return row;
  };

  // Actions ------------------------------------------------------------------------------------

  /**
   * Grammar first. For timing it does not know, one model request outside the conversation,
   * shown for confirmation before anything is saved. Undefined when the user declines.
   */
  const resolve = async (text: string, current: ExtensionContext, target: string): Promise<{ schedule: Schedule; prompt: string } | undefined> => {
    const model = current.model;
    try {
      const { schedule: timing, rest } = parseTiming(text);
      if (!rest) throw new Error(`Missing prompt.\n${USAGE}`);
      return { schedule: timing, prompt: rest };
    } catch (error) {
      if (!(error instanceof UnknownTimingError) || !current.hasUI || !model) throw error;
      // A single word ("lsit", or nothing at all) holds no timing and task worth a model call.
      if (text.split(/\s+/).filter(Boolean).length < 2) throw new Error(`${message(error)}\n${USAGE}`);
    }
    notify(`Reading the schedule with ${model.name || model.id}…`);
    const { timing: canonical, prompt } = await interpretSchedule(current.modelRegistry, model, text, Date.now(), AbortSignal.timeout(INTERPRET_TIMEOUT_MS));
    const check = (now: number) => {
      let parsed: { schedule: Schedule; rest: string };
      try { parsed = parseTiming(canonical, now); } catch (error) { throw new Error(`The model suggested "${canonical}": ${message(error)}`); }
      if (parsed.rest) throw new Error(`The model suggested an invalid timing: "${canonical}".`);
      return parsed.schedule;
    };
    const proposed = check(Date.now());
    const runs = upcoming(proposed, Date.now(), proposed.kind === "once" ? 1 : 3);
    const confirmed = await current.ui.confirm(`Schedule in ${target}?`, `${describeSchedule(proposed)}\n${proposed.kind === "once" ? "Runs" : "Next runs"}: ${runs.join(", ")}\nPrompt: ${prompt}`);
    // Parse again: the dialog may have stayed open past a one-shot's time ("in 1m").
    return confirmed ? { schedule: check(Date.now()), prompt } : undefined;
  };

  const addSession = async (text: string, current: ExtensionContext) => {
    const resolved = await resolve(text, current, "this session");
    if (!resolved) return;
    const { schedule: timing, prompt } = resolved;
    const now = Date.now();
    const job: LiveJob = { id: newId(), prompt, schedule: timing, createdAt: now, nextAt: nextRun(timing, now) };
    jobs.push(job);
    changed();
    // Pi writes the session file only once it has a conversation; until then the job lives in memory.
    const unsaved = current.sessionManager.getEntries().some((entry) => entry.type === "message") ? "" : "\nThis session is not saved until its first message: closing Pi before then loses the job.";
    notify(`Scheduled ${job.id} in this session: ${scheduleText(timing, now)}\nPrompt: ${preview(prompt, 80)}${unsaved}`);
  };

  const addBackground = async (text: string, current: ExtensionContext) => {
    let rest = text;
    let catchUp = true;
    let timeoutSec = DEFAULT_TIMEOUT_SEC;
    let tools: string | undefined;
    for (let option = BG_OPTION.exec(rest); option; option = BG_OPTION.exec(rest)) {
      rest = rest.slice(option[0].length);
      if (option[1] === "no-catchup") { catchUp = false; continue; }
      const value = /^(\S+)\s*/.exec(rest);
      if (!value) throw new Error(`--${option[1]} needs a value.`);
      rest = rest.slice(value[0].length);
      if (option[1] === "tools") tools = value[1];
      else {
        const ms = parseDuration(value[1]);
        if (!ms) throw new Error(`Invalid --timeout "${value[1]}"; use e.g. 10m or 1h.`);
        timeoutSec = Math.ceil(ms / 1000);
      }
    }
    if (!rest) throw new Error(USAGE);
    const resolved = await resolve(rest, current, "background");
    if (!resolved) return;
    const { schedule: timing, prompt } = resolved;
    // An option after the timing would otherwise become prompt text, and --tools would be lost.
    if (BG_OPTION.test(prompt)) throw new Error(`Put options before the timing: /schedule bg ${prompt.split(/\s+/)[0]} … <timing> <prompt>`);
    const now = Date.now();
    // Pin the model in use now: launchd runs would otherwise follow whatever the default becomes.
    const model = current.model ? `${current.model.provider}/${current.model.id}:${pi.getThinkingLevel()}` : undefined;
    const job: BackgroundJob = { id: newId(), prompt, cwd: current.cwd, schedule: timing, enabled: true, catchUp, timeoutSec, model, tools, createdAt: now };
    const lines = [
      `Scheduled ${job.id} in background: ${scheduleText(timing, now)}`,
      `Prompt: ${preview(prompt, 80)}`,
      `cwd ${current.cwd}${model ? `, ${model}` : ""}, tools ${tools ?? "default"}, timeout ${formatDuration(timeoutSec * 1000)}${catchUp ? "" : ", no catch-up"}`,
    ];
    // Background runs get no API keys from the environment (see ENV_KEYS).
    let source: string | undefined;
    try { source = current.model ? current.modelRegistry.getProviderAuthStatus(current.model.provider).source : undefined; } catch { /* no registry */ }
    if (source === "environment") lines.push(`Warning: ${current.model?.provider} authenticates from an environment variable, which background runs do not get. Use /login or store the key in auth.json.`);
    updateBackground((existing) => [...existing, job]);
    // One notification: a second one would replace the first before it is read.
    try {
      const agent = await syncAgent(true);
      if (agent) lines.push(agent);
      notify(lines.join("\n"), source === "environment" ? "warning" : "info");
    } catch (error) {
      notify(`${lines.join("\n")}\nThe launchd agent failed: ${message(error)}. Run /schedule doctor.`, "error");
    }
  };

  const sessionJob = (id: string) => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`No scheduled job "${id}"; it may have just run.`);
    return job;
  };

  const runNow = (row: Row) => {
    if (row.bg) {
      runBackgroundNow(row.id);
      notify(`Started ${row.id} in background; results arrive as a notification and in /schedule log ${row.id}.`);
      return;
    }
    const job = sessionJob(row.id);
    if (job.schedule.kind === "once") {
      jobs = jobs.filter((candidate) => candidate !== job);
      changed();
    }
    send(job);
  };

  const remove = async (row: Row) => {
    if (row.bg) {
      updateBackground((existing) => existing.filter((job) => job.id !== row.id));
      forgetJob(dir, row.id);
      const agent = await syncAgent(false).catch((error: unknown) => `launchd: ${message(error)}`);
      notify(`Removed ${row.id}.${agent ? ` ${agent}.` : ""}`);
      return;
    }
    jobs = jobs.filter((job) => job.id !== row.id);
    changed();
    notify(`Removed ${row.id}.`);
  };

  const setPaused = (row: Row, paused: boolean) => {
    const now = Date.now();
    if (row.bg) {
      // resumedAt skips recurring slots that passed while paused. A one-shot keeps its slot: it
      // runs on resume if still within catch-up, or is recorded as missed.
      updateBackground((existing) => existing.map((job) => job.id !== row.id ? job
        : paused ? { ...job, enabled: false }
        : { ...job, enabled: true, ...(job.schedule.kind === "once" ? {} : { resumedAt: now }) }));
    } else {
      const job = sessionJob(row.id);
      job.paused = paused;
      // Resuming skips slots that passed while paused; a passed one-shot fires on the next tick.
      if (!paused && job.schedule.kind !== "once") job.nextAt = nextRun(job.schedule, now);
      changed();
    }
    notify(`${paused ? "Paused" : "Resumed"} ${row.id}.`);
  };

  const showLog = (row: Row) => {
    if (!row.bg) { notify(`${row.id} runs in this conversation; its prompts are in the transcript.`); return; }
    const now = Date.now();
    const runs = readRuns(dir, row.id, 10);
    const lines = runs.map((run) => `${formatTime(run.startedAt, now)}  ${run.status.padEnd(7)} ${run.sessionId ? `pi --session ${run.sessionId}` : ""}\n  ${preview(run.output ?? "", 160)}`);
    notify(`${row.id} (${row.bg.cwd})\n${lines.join("\n") || "No runs yet."}`);
  };

  const openLastRun = async (row: Row, current: ExtensionCommandContext) => {
    const path = row.bg && row.lastSessionId ? SessionManager.findById(row.bg.cwd, row.lastSessionId) : undefined;
    if (!path) { notify(`No saved session for the last run of ${row.id}.`, "warning"); return; }
    await current.switchSession(path);
  };

  const doctor = async () => {
    const lines = [`store: ${dir}`, `plist: ${plistPath()} (${existsSync(plistPath()) ? "present" : "missing"})`, `launchd: ${await agentStatus()}`];
    try {
      const sync = await syncAgent(true);
      if (sync) lines.push(`repaired: ${sync}`);
    } catch (error) { lines.push(`repair failed: ${message(error)}`); }
    try {
      const tail = readFileSync(join(dir, "logs", "dispatch.log"), "utf8").trimEnd().split("\n").slice(-5);
      lines.push("dispatch.log:", ...tail.map((line) => `  ${line}`));
    } catch { lines.push("dispatch.log: empty"); }
    notify(lines.join("\n"));
  };

  const manage = async (current: ExtensionCommandContext) => {
    const all = rows();
    if (!current.hasUI || !all.length) { notify(all.length ? listText() : `No scheduled jobs.\n${USAGE}`); return; }
    const labels = all.map(label);
    const picked = await current.ui.select("Scheduled jobs", labels);
    const chosen = picked === undefined ? undefined : all[labels.indexOf(picked)];
    if (!chosen) return;
    const actions = ["Run now", chosen.paused ? "Resume" : "Pause", "Delete", ...(chosen.bg ? ["Show runs"] : []), ...(chosen.lastSessionId ? ["Open last run session"] : [])];
    const action = await current.ui.select(`${chosen.id}: ${preview(chosen.prompt, 60)}`, actions);
    if (action === undefined) return;
    // Look the job up again: it may have fired or been removed while the menus were open.
    const row = find(chosen.id);
    if (action === "Run now") runNow(row);
    else if (action === "Pause" || action === "Resume") setPaused(row, action === "Pause");
    else if (action === "Delete") await remove(row);
    else if (action === "Show runs") showLog(row);
    else if (action === "Open last run session") await openLastRun(row, current);
  };

  // Lifecycle ----------------------------------------------------------------------------------

  pi.on("session_start", (event, current) => {
    ctx = current;
    disarm();
    const now = Date.now();
    // A fork or clone copies the snapshot, but its jobs stay with the original session; firing them
    // here too would run each job twice. The empty snapshot keeps the fork empty on resume as well.
    if (event.reason === "fork") {
      jobs = [];
      if (!latestSnapshot(current.sessionManager.getEntries()).length) return;
      changed();
      notify("Schedule: session jobs stay with the original session, not this fork.");
      return;
    }
    const saved = latestSnapshot(current.sessionManager.getEntries());
    const dropped = saved.filter((job) => job.schedule.kind === "once" && job.schedule.at < now - RESTORE_GRACE_MS);
    jobs = saved.filter((job) => !dropped.includes(job)).map((job) => ({
      ...job,
      // A one-shot that came due during a reload still fires; recurring jobs skip missed slots.
      nextAt: job.schedule.kind === "once" ? job.schedule.at : nextRun(job.schedule, now),
    }));
    // Arm the timer; write a new snapshot only if restoring dropped something.
    if (saved.length) changed(dropped.length > 0);
    if (dropped.length) notify(`Schedule: dropped one-shot jobs that passed while the session was closed: ${dropped.map((job) => job.id).join(", ")}`, "warning");
    if (jobs.length && event.reason !== "reload") notify(`Schedule: ${jobs.length} session job(s) active. /schedule to manage.`);
    // Self-heal the LaunchAgent (e.g. after an nvm upgrade moved node) once per interactive Pi start.
    if (current.mode === "tui" && event.reason === "startup") {
      syncAgent(false).then((result) => { if (result) notify(`Schedule: ${result}.`); }, (error: unknown) => notify(`Schedule: launchd agent: ${message(error)}`, "warning"));
    }
  });

  pi.on("session_shutdown", () => {
    disarm();
    try { if (ctx?.hasUI) ctx.ui.setStatus("schedule", undefined); } catch { /* stale ctx */ }
    ctx = undefined;
  });

  pi.registerCommand("schedule", {
    description: "Schedule prompts: /schedule [bg] <timing> <prompt> | list | run|rm|pause|resume|log <id> | doctor",
    getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
      const parts = prefix.split(/\s+/);
      if (parts.length === 1) {
        const matches = SUBCOMMANDS.filter((name) => name.startsWith(parts[0]));
        return matches.length ? matches.map((name) => ({ value: name, label: name })) : null;
      }
      if (parts.length === 2 && ID_COMMANDS.has(parts[0])) {
        const matches = rows().filter((row) => row.id.startsWith(parts[1]));
        return matches.length ? matches.map((row) => ({ value: `${parts[0]} ${row.id}`, label: row.id, description: `${row.target} ${preview(row.prompt, 40)}` })) : null;
      }
      return null;
    },
    handler: async (args, current) => {
      ctx = current;
      const text = args.trim();
      const [command = "", id] = text.split(/\s+/);
      try {
        switch (command) {
          case "": await manage(current); break;
          case "list": notify(listText()); break;
          case "bg": await addBackground(text.slice(2).trim(), current); break;
          case "doctor": await doctor(); break;
          case "run": runNow(find(id)); break;
          case "rm": await remove(find(id)); break;
          case "pause": setPaused(find(id), true); break;
          case "resume": setPaused(find(id), false); break;
          case "log": showLog(find(id)); break;
          default: await addSession(text, current);
        }
      } catch (error) {
        notify(message(error), "error");
      }
    },
  });
}
