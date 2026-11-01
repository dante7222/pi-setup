// Timing grammar and schedule math. No Pi imports: the launchd dispatcher runs this under plain node.
import { CronExpressionParser } from "cron-parser";

export type Schedule =
  | { kind: "once"; at: number }
  | { kind: "every"; ms: number; anchor: number }
  | { kind: "cron"; expr: string };

export const TIMING_HELP = 'in 20 minutes | at 5pm | tomorrow 9am | friday 3pm | on 2026-12-01 10:00 | every 2h | every day at 5am | weekdays 9:00 | every monday 10am | hourly | cron "*/15 * * * *"';

/** The grammar did not recognize the timing at all; callers may try a model instead. */
export class UnknownTimingError extends Error {}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UNITS: Record<string, number> = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: DAY, w: 7 * DAY };
const UNIT_WORDS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: 60 * MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
/**
 * A prompt starting like this probably holds timing the grammar did not consume ("except weekends",
 * "next week", "30 minutes", "on the 1st", "UTC"). Connectors such as "in", "on" or "and" and words
 * such as "every" or "next" only count before a time or day word: tasks often start with them.
 */
const UNIT = String.raw`(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?|years?)`;
const DAY_WORD = String.raw`(?:(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?|weekdays?|weekends?|daily|everyday|weekly|monthly|yearly|hourly|tomorrow|today|tonight)`;
const TIMING_CORE = [
  String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)`, String.raw`\d{1,2}:\d{2}`, "noon", "midnight", DAY_WORD,
  String.raw`(?:every|each)\s+(?:other|\d+|an?|day|week|month|year|${UNIT}|${DAY_WORD})`,
  String.raw`(?:next|this|coming|following)\s+(?:week|month|year|${DAY_WORD})`,
  String.raw`(?:the\s+)?\d{1,2}(?:st|nd|rd|th)`, String.raw`(?:the\s+)?day\s+after\s+tomorrow`,
  String.raw`\d+\s*${UNIT}`, String.raw`an?\s+(?:half|hour|day|week|month)`, "utc", "gmt", "[ecmp][sd]t",
].join("|");
const TIMING_WORD = new RegExp(String.raw`^(?:(?:except|excluding|until|till|through|thru|starting|beginning|between|unless)\b|(?:(?:and|or|&|at|on|in|from|to|for|after|before|by|then)\s+){0,2}(?:${TIMING_CORE})(?![\w']))`, "i");

/** "1h30m" -> milliseconds; undefined when the token is not a compact duration. */
export function parseDuration(token: string): number | undefined {
  if (!/^(\d+[smhdw])+$/i.test(token)) return undefined;
  let total = 0;
  for (const [, count, unit] of token.toLowerCase().matchAll(/(\d+)([smhdw])/g)) total += Number(count) * UNITS[unit];
  return total || undefined;
}

export function formatDuration(ms: number): string {
  let rest = ms;
  let out = "";
  for (const unit of ["d", "h", "m", "s"]) {
    const count = Math.floor(rest / UNITS[unit]);
    if (count) out += `${count}${unit}`;
    rest -= count * UNITS[unit];
  }
  return out || "0s";
}

/** Local wall-clock time on the day `dayOffset` days after `now`. */
function atClock(now: number, [hour, minute]: [number, number], dayOffset: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

type Clock = [number, number];
interface Match<T> { value: T; end: number }
type Day = { recurring: string } | { date: (clock: Clock) => number };

/** Leading words (lowercased, trailing commas dropped) and the untouched remainder after `n` of them. */
function tokenize(text: string, count: number): { tokens: string[]; rest: (n: number) => string } {
  const tokens: string[] = [];
  const offsets: number[] = [0];
  let position = 0;
  while (tokens.length < count) {
    const match = /^(\S+)\s*/.exec(text.slice(position));
    if (!match) break;
    tokens.push(match[1].toLowerCase().replace(/[,;]$/, ""));
    position += match[0].length;
    offsets.push(position);
  }
  return { tokens, rest: (n) => text.slice(offsets[n]).trim() };
}

/** "5am", "5 am", "17:30", "9:30pm", "noon", "midnight", with an optional leading "at". */
function clockAt(tokens: string[], start: number): Match<Clock> | undefined {
  const index = tokens[start] === "at" ? start + 1 : start;
  const token = tokens[index];
  if (token === "noon") return { value: [12, 0], end: index + 1 };
  if (token === "midnight") return { value: [0, 0], end: index + 1 };
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/.exec(token ?? "");
  if (!match) return undefined;
  let suffix = match[3];
  let end = index + 1;
  const next = tokens[index + 1];
  if (!suffix && (next === "am" || next === "pm" || next === "a.m." || next === "p.m.")) { suffix = next; end++; }
  // A bare number is not a time: "at 9 check" is ambiguous.
  if (match[2] === undefined && !suffix) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (suffix) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (suffix.startsWith("p") ? 12 : 0);
  }
  return hour > 23 || minute > 59 ? undefined : { value: [hour, minute], end };
}

/** One part: "20m", "1h30m", "20 minutes", "an hour"; with `bare`, a lone unit ("hour") means one. `unit` is its smallest unit. */
function durationPart(tokens: string[], index: number, bare: boolean): (Match<number> & { unit: number }) | undefined {
  const token = tokens[index] ?? "";
  const compact = parseDuration(token);
  if (compact) return { value: compact, end: index + 1, unit: UNITS[token.at(-1)!.toLowerCase()] };
  const unit = UNIT_WORDS[tokens[index + 1] ?? ""];
  if (unit && /^\d+$/.test(token) && Number(token) > 0) return { value: Number(token) * unit, end: index + 2, unit };
  if (unit && (token === "a" || token === "an")) return { value: unit, end: index + 2, unit };
  if (bare && UNIT_WORDS[token] && token.length > 1) return { value: UNIT_WORDS[token], end: index + 1, unit: UNIT_WORDS[token] };
  return undefined;
}

/** One or more parts: "1 hour 30 minutes", "1h, 30m", "3 hours and 15 minutes", "an hour and a half". */
function durationAt(tokens: string[], index: number, bare: boolean): Match<number> | undefined {
  const first = durationPart(tokens, index, bare);
  if (!first) return undefined;
  let { value, end, unit } = first;
  for (;;) {
    const skip = tokens[end] === "and" ? 1 : 0;
    if (tokens[end + skip] === "a" && tokens[end + skip + 1] === "half") return { value: value + unit / 2, end: end + skip + 2 };
    const part = durationPart(tokens, end + skip, false);
    if (!part) return { value, end };
    value += part.value;
    end = part.end;
    unit = part.unit;
  }
}

function weekday(token: string | undefined): number | undefined {
  return token === undefined ? undefined : WEEKDAYS[token];
}

/** A recurring day pattern (cron day-of-week) or one specific day, with an optional leading "on". */
function dayAt(tokens: string[], start: number, now: number): Match<Day> | undefined {
  const index = tokens[start] === "on" ? start + 1 : start;
  const [first, second] = [tokens[index], tokens[index + 1]];
  const recurring = (dow: string, length: number): Match<Day> => ({ value: { recurring: dow }, end: index + length });
  if (first === "daily" || first === "everyday") return recurring("*", 1);
  if (first === "weekdays") return recurring("1-5", 1);
  if (first === "weekends") return recurring("0,6", 1);
  if (first === "every" || first === "each") {
    if (second === "day") return recurring("*", 2);
    if (second === "weekday") return recurring("1-5", 2);
    if (second === "weekend") return recurring("0,6", 2);
    const day = weekday(second);
    if (day !== undefined) return recurring(String(day), 2);
    return undefined;
  }
  // "mondays" recurs; "monday" is the next one. Check singular first: "tues" and "thurs" end in s.
  const single = weekday(first);
  const plural = single === undefined && first?.endsWith("s") ? weekday(first.slice(0, -1)) : undefined;
  if (plural !== undefined) return recurring(String(plural), 1);
  const date = (offset: (clock: Clock) => number, length: number): Match<Day> => ({ value: { date: (clock) => atClock(now, clock, offset(clock)) }, end: index + length });
  if (first === "today") return date(() => 0, 1);
  if (first === "tomorrow") return date(() => 1, 1);
  const today = new Date(now).getDay();
  if (first === "next" && weekday(second) !== undefined) return date(() => ((weekday(second)! - today + 7) % 7) || 7, 2);
  if (single !== undefined) {
    // Today if that time is still ahead, otherwise next week.
    return date((clock) => {
      const ahead = (single - today + 7) % 7;
      return ahead === 0 && atClock(now, clock, 0) <= now ? 7 : ahead;
    }, 1);
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(first ?? "");
  if (iso) {
    const [year, month, dayOfMonth] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
    const day = new Date(year, month, dayOfMonth);
    // Date rolls 2026-11-31 over to December 1st; reject it instead.
    if (day.getMonth() !== month || day.getDate() !== dayOfMonth) throw new Error(`No such date: ${first}.`);
    const target = day.getTime();
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    return date(() => Math.round((target - midnight) / DAY), 1);
  }
  return undefined;
}

function cronExpr(expr: string): string {
  const normalized = expr.trim().split(/\s+/).join(" ");
  // Five fields only: a sixth (seconds) field means nothing to a once-a-minute dispatcher.
  if (normalized.split(" ").length !== 5) throw new Error(`Cron needs 5 fields (minute hour day month weekday): "${expr}"`);
  // Valid syntax can still never fire ("0 9 31 2 *"); next() then throws.
  try { CronExpressionParser.parse(normalized).next(); } catch (error) {
    throw new Error(`Cron "${normalized}" ${/loop limit/i.test(error instanceof Error ? error.message : "") ? "never fires" : "is invalid"}.`);
  }
  return normalized;
}

function build(day: Day, [hour, minute]: Clock, now: number): Schedule {
  if ("recurring" in day) return { kind: "cron", expr: `${minute} ${hour} * * ${day.recurring}` };
  const at = day.date([hour, minute]);
  if (at <= now) throw new Error("That time has already passed.");
  return { kind: "once", at };
}

/** The timing prefix alone; the remainder is returned as the prompt. */
function grammar(text: string, now: number): { schedule: Schedule; rest: string } {
  const cron = /^cron\s+(["'])(.+?)\1([\s\S]*)$/i.exec(text);
  if (cron) return { schedule: { kind: "cron", expr: cronExpr(cron[2]) }, rest: cron[3].trim() };
  const { tokens, rest } = tokenize(text, 12);
  if (tokens[0] === "hourly") return { schedule: { kind: "cron", expr: "0 * * * *" }, rest: rest(1) };
  if (tokens[0] === "in") {
    const duration = durationAt(tokens, 1, false);
    if (duration) return { schedule: { kind: "once", at: now + duration.value }, rest: rest(duration.end) };
  }
  // A day first: "every day at 5am", "weekdays 9:00", "tomorrow 9am", "friday 3pm".
  const day = dayAt(tokens, 0, now);
  if (day) {
    const clock = clockAt(tokens, day.end);
    // No readable time after the day ("every weekday at 9", "tomorrow morning", "mondays and
    // thursdays at 9am"): beyond the grammar, so the model may read it; without one, say what to add.
    if (!clock) throw new UnknownTimingError(`Add a time, e.g. "${tokens.slice(0, day.end).join(" ")} at 9am".`);
    return { schedule: build(day.value, clock.value, now), rest: rest(clock.end) };
  }
  if (tokens[0] === "every" || tokens[0] === "each") {
    const duration = durationAt(tokens, 1, true);
    if (duration) {
      if (duration.value < MINUTE) throw new Error("Shortest interval is 1m.");
      return { schedule: { kind: "every", ms: duration.value, anchor: now }, rest: rest(duration.end) };
    }
  }
  // A time first: "at 5pm", "5am every day", "at 9:30 tomorrow".
  const clock = clockAt(tokens, 0);
  if (clock) {
    const after = dayAt(tokens, clock.end, now);
    if (after) return { schedule: build(after.value, clock.value, now), rest: rest(after.end) };
    const today = atClock(now, clock.value, 0);
    return { schedule: { kind: "once", at: today > now ? today : atClock(now, clock.value, 1) }, rest: rest(clock.end) };
  }
  throw new UnknownTimingError(`Unknown timing. Use: ${TIMING_HELP}`);
}

/**
 * Parse a timing prefix; everything after it is the prompt. Throws UnknownTimingError when the
 * timing is not recognized, or when the prompt seems to start with more timing words the
 * grammar could not place ("at 5pm every other day ..."), so nothing is silently misread.
 */
export function parseTiming(input: string, now = Date.now()): { schedule: Schedule; rest: string } {
  const parsed = grammar(input.trim(), now);
  if (TIMING_WORD.test(parsed.rest)) throw new UnknownTimingError(`Could not read the whole timing in "${input.trim()}".`);
  return parsed;
}

/** First slot strictly after `after`, or undefined when the schedule is over. */
export function nextRun(schedule: Schedule, after: number): number | undefined {
  switch (schedule.kind) {
    case "once":
      return schedule.at > after ? schedule.at : undefined;
    case "every": {
      // Slots are anchor + k*ms for k >= 1, so they stay on the grid set at creation.
      const k = Math.max(1, Math.floor((after - schedule.anchor) / schedule.ms) + 1);
      return schedule.anchor + k * schedule.ms;
    }
    case "cron":
      return CronExpressionParser.parse(schedule.expr, { currentDate: new Date(after) }).next().getTime();
  }
}

/** Latest slot in (since, now], or undefined. Older missed slots are deliberately ignored. */
export function lastDue(schedule: Schedule, now: number, since: number): number | undefined {
  let slot: number | undefined;
  switch (schedule.kind) {
    case "once":
      slot = schedule.at <= now ? schedule.at : undefined;
      break;
    case "every": {
      const k = Math.floor((now - schedule.anchor) / schedule.ms);
      slot = k >= 1 ? schedule.anchor + k * schedule.ms : undefined;
      break;
    }
    case "cron": {
      // Gate on nextRun so both share cron-parser's DST rules: a slot repeated when clocks go back
      // runs once, and one skipped when they go forward runs at the shifted time nextRun reports.
      const next = nextRun(schedule, since);
      if (next === undefined || next > now) return undefined;
      // prev() is strictly before currentDate; start one second late so a slot at exactly `now` counts.
      const expression = CronExpressionParser.parse(schedule.expr, { currentDate: new Date(now + 1000) });
      let previous = expression.prev().getTime();
      if (previous > now) previous = expression.prev().getTime();
      slot = Math.max(next, previous);
      break;
    }
  }
  return slot !== undefined && slot > since ? slot : undefined;
}

/** Local "YYYY-MM-DD HH:MM". */
export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "HH:MM" today, the full local date otherwise. */
export function formatTime(ms: number, now = Date.now()): string {
  const full = formatDateTime(ms);
  return new Date(now).toDateString() === new Date(ms).toDateString() ? full.slice(11) : full;
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The next `count` slots after `now`, for confirmation dialogs: "Mon 2026-11-02 09:00". */
export function upcoming(schedule: Schedule, now: number, count: number): string[] {
  const out: string[] = [];
  for (let at = nextRun(schedule, now); at !== undefined && out.length < count; at = nextRun(schedule, at)) {
    out.push(`${DAY_NAMES[new Date(at).getDay()].slice(0, 3)} ${formatDateTime(at)}`);
  }
  return out;
}

export function describeSchedule(schedule: Schedule, now = Date.now()): string {
  switch (schedule.kind) {
    case "once": return `at ${formatTime(schedule.at, now)}`;
    case "every": return `every ${formatDuration(schedule.ms)}`;
    case "cron": {
      // Readable names for what the grammar generates; anything else stays raw cron.
      const match = /^(\d+) (\d+) \* \* (\*|1-5|0,6|[0-6])$/.exec(schedule.expr);
      if (!match) return `cron ${schedule.expr}`;
      const time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
      const days = match[3] === "*" ? "daily" : match[3] === "1-5" ? "weekdays" : match[3] === "0,6" ? "weekends" : `every ${DAY_NAMES[Number(match[3])]}`;
      return `${days} ${time}`;
    }
  }
}
