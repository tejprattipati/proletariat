import { DateTime } from "luxon";
import type { PlanBlock, WorkspaceState } from "../types";
import { assert, stableId, validateDate, validateTimezone } from "./core";

type Interval = { start: number; end: number };
export interface PlanResult { blocks: PlanBlock[]; unscheduledTaskIds: string[]; remainingMinutes: Record<string, number>; conflicts: string[]; }
export interface PlanOptions { bufferMinutes?: number; minimumBlockMinutes?: number; now?: Date; }
const minute = 60_000;

function merge(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const value of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && value.start <= last.end) last.end = Math.max(last.end, value.end);
    else merged.push({ ...value });
  }
  return merged;
}

function available(start: number, end: number, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = start;
  for (const block of merge(busy)) {
    if (block.end <= cursor) continue;
    if (block.start >= end) break;
    if (block.start > cursor) free.push({ start: cursor, end: Math.min(block.start, end) });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < end) free.push({ start: cursor, end });
  return free;
}

function instant(value: string): number {
  assert(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value), "Calendar times must include a UTC offset.");
  const time = DateTime.fromISO(value, { setZone: true });
  assert(time.isValid, "Calendar times must be valid ISO timestamps.");
  return time.toMillis();
}

export function validateInterval(start: string, end: string): void {
  assert(instant(end) > instant(start), "End must be after start.");
}

export function generatePlan(state: WorkspaceState, date = state.today, options: PlanOptions = {}): PlanResult {
  validateDate(date);
  const zone = validateTimezone(state.settings.timezone);
  const buffer = options.bufferMinutes ?? 10;
  const minimum = options.minimumBlockMinutes ?? 15;
  assert(Number.isFinite(buffer) && buffer >= 0 && buffer <= 120, "Buffer must be between 0 and 120 minutes.");
  assert(Number.isFinite(minimum) && minimum > 0, "Minimum block duration must be positive.");
  const wallTime = (time: string) => {
    assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), "Working hours must use HH:mm.");
    const result = DateTime.fromISO(`${date}T${time}`, { zone });
    assert(result.isValid && result.toFormat("HH:mm") === time, "Working hours fall in a nonexistent local time.");
    return result.toMillis();
  };
  const workingStart = wallTime(state.settings.workingHoursStart);
  const end = wallTime(state.settings.workingHoursEnd);
  assert(end > workingStart, "Working hours must end after they start on the same local day.");
  if (options.now) assert(Number.isFinite(options.now.getTime()), "A valid planning time is required.");
  const start = Math.max(workingStart, options.now ? Math.ceil(options.now.getTime() / minute) * minute : workingStart);
  const dayStart = DateTime.fromISO(date, { zone }).startOf("day").toMillis();
  const dayEnd = DateTime.fromISO(date, { zone }).plus({ days: 1 }).startOf("day").toMillis();
  const busy: Interval[] = [];
  const eventIntervals: Interval[] = [];
  for (const event of state.events) {
    validateInterval(event.start, event.end);
    const interval = { start: instant(event.start) - buffer * minute, end: instant(event.end) + buffer * minute };
    busy.push(interval);
    eventIntervals.push(interval);
  }
  const blocks = state.plan.filter(block => block.pinned && instant(block.start) < dayEnd && instant(block.end) > dayStart).map(block => ({ ...block }));
  const conflicts: string[] = [];
  const pinnedMinutes: Record<string, number> = {};
  const pins: Interval[] = [];
  for (const block of blocks) {
    validateInterval(block.start, block.end);
    const interval = { start: instant(block.start), end: instant(block.end) };
    if (interval.start < workingStart || interval.end > end) conflicts.push(`Pinned block ${block.id} is outside working hours.`);
    if ([...eventIntervals, ...pins].some(other => interval.start < other.end && interval.end > other.start)) conflicts.push(`Pinned block ${block.id} overlaps another commitment or its buffer.`);
    if (!state.tasks.some(task => task.id === block.taskId)) conflicts.push(`Pinned block ${block.id} has no task.`);
    pinnedMinutes[block.taskId] = (pinnedMinutes[block.taskId] ?? 0) + (interval.end - interval.start) / minute;
    pins.push({ start: interval.start - buffer * minute, end: interval.end + buffer * minute });
    busy.push(pins.at(-1)!);
  }
  const tasks = state.tasks.filter(task => task.status !== "done" && task.plannedDate <= date &&
    (!task.nextActionDate || task.nextActionDate <= date) && (task.status !== "waiting" || Boolean(task.nextActionDate && task.nextActionDate <= date)))
    .sort((a, b) => a.priority.localeCompare(b.priority) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
      (a.dueTime ?? "23:59").localeCompare(b.dueTime ?? "23:59") || a.plannedDate.localeCompare(b.plannedDate) || a.id.localeCompare(b.id));
  const remainingMinutes: Record<string, number> = {};
  for (const task of tasks) {
    assert(Number.isFinite(task.estimateMinutes) && task.estimateMinutes > 0, `Task ${task.id} needs a positive duration.`);
    let remaining = Math.max(0, task.estimateMinutes - (pinnedMinutes[task.id] ?? 0));
    let limit = end;
    if (task.dueDate === date && task.dueTime) limit = Math.min(limit, wallTime(task.dueTime));
    for (const slot of available(start, limit, busy)) {
      if (remaining <= 0) break;
      const capacity = (slot.end - slot.start) / minute;
      if (!task.splittable && capacity < remaining) continue;
      const duration = Math.min(remaining, capacity);
      if (duration < Math.min(minimum, remaining)) continue;
      const finish = slot.start + duration * minute;
      blocks.push({ id: stableId("block", task.id, date, slot.start), taskId: task.id,
        start: new Date(slot.start).toISOString(), end: new Date(finish).toISOString(), pinned: false });
      busy.push({ start: slot.start - buffer * minute, end: finish + buffer * minute });
      remaining -= duration;
    }
    if (remaining > 0) remainingMinutes[task.id] = remaining;
  }
  blocks.sort((a, b) => instant(a.start) - instant(b.start) || a.id.localeCompare(b.id));
  return { blocks, remainingMinutes, unscheduledTaskIds: Object.keys(remainingMinutes), conflicts };
}
