import { DateTime } from "luxon";
import { DEFAULT_CATEGORIES, type CalendarEvent, type Task, type WorkspaceState } from "../types";
import { localDate, validateDate, validateTimezone } from "./core";
import { hasUnknownProviderState, hasUnverifiedRequirement, isActiveTask, isProviderComplete } from "./lifecycle";

export interface TaskProjectionFilter {
  view?: "active" | "completed" | "removed" | "history" | "all";
  priority?: Task["priority"];
  category?: string;
  plannedDate?: string;
  dueDate?: string;
  status?: Task["status"];
  completedDate?: string;
  removedDate?: string;
  q?: string;
}

const byDeadline = (a: Task, b: Task) => (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") ||
  (a.dueTime ?? "23:59").localeCompare(b.dueTime ?? "23:59") || a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id);

/** Every view contains references to the same canonical records, never editable copies. */
export function selectTasks(state: WorkspaceState, filter: TaskProjectionFilter = {}): Task[] {
  const view = filter.view ?? "active";
  if (filter.plannedDate) validateDate(filter.plannedDate);
  if (filter.dueDate) validateDate(filter.dueDate);
  if (filter.completedDate) validateDate(filter.completedDate);
  if (filter.removedDate) validateDate(filter.removedDate);
  const query = filter.q?.trim().toLowerCase();
  return state.tasks.filter(task => {
    const visible = view === "all" || (view === "active" ? isActiveTask(task) : view === "completed" ? !task.removedAt && task.status === "done" :
      view === "removed" ? Boolean(task.removedAt) : !isActiveTask(task));
    return visible && (!filter.priority || task.priority === filter.priority) && (!filter.category || task.categories?.includes(filter.category)) &&
      (!filter.plannedDate || task.plannedDate === filter.plannedDate) && (!filter.dueDate || task.dueDate === filter.dueDate) &&
      (!filter.completedDate || Boolean(task.completedAt && localDate(new Date(task.completedAt), state.settings.timezone) === filter.completedDate)) &&
      (!filter.removedDate || Boolean(task.removedAt && localDate(new Date(task.removedAt), state.settings.timezone) === filter.removedDate)) &&
      (!filter.status || task.status === filter.status) && (!query || [task.title, task.nextAction, task.notes, ...(task.categories ?? [])].some(value => value?.toLowerCase().includes(query)));
  }).sort(byDeadline);
}

export interface TaskProjections {
  active: Task[];
  byPriority: Record<Task["priority"], Task[]>;
  byCategory: Record<string, Task[]>;
  byPlannedDate: Record<string, Task[]>;
  byDueDate: Record<string, Task[]>;
  deadlines: Task[];
  overdue: Task[];
  planned: Task[];
  waiting: Task[];
  fixedEvents: CalendarEvent[];
  completed: Task[];
  removed: Task[];
  providerCompleted: Task[];
}

export function projectTasks(state: WorkspaceState, date = state.today): TaskProjections {
  validateDate(date);
  const active = selectTasks(state);
  const grouped = (keys: string[], getKeys: (task: Task) => string[]) => Object.fromEntries([...new Set(keys)].sort().map(key => [key, active.filter(task => getKeys(task).includes(key))]));
  const zone = validateTimezone(state.settings.timezone);
  const start = DateTime.fromISO(date, { zone }).startOf("day").toMillis();
  const end = DateTime.fromISO(date, { zone }).plus({ days: 1 }).startOf("day").toMillis();
  return {
    active,
    byPriority: { P0: active.filter(task => task.priority === "P0"), P1: active.filter(task => task.priority === "P1"), P2: active.filter(task => task.priority === "P2") },
    byCategory: grouped([...DEFAULT_CATEGORIES, ...active.flatMap(task => task.categories ?? [])], task => task.categories ?? []),
    byPlannedDate: grouped(active.map(task => task.plannedDate), task => [task.plannedDate]),
    byDueDate: grouped(active.flatMap(task => task.dueDate ? [task.dueDate] : []), task => task.dueDate ? [task.dueDate] : []),
    deadlines: active.filter(task => task.dueDate && task.dueDate <= date),
    overdue: active.filter(task => task.dueDate && task.dueDate < date && !hasUnknownProviderState(task) && !hasUnverifiedRequirement(task)),
    planned: active.filter(task => task.plannedDate === date && task.status !== "waiting" && task.status !== "blocked" && !hasUnknownProviderState(task) && !hasUnverifiedRequirement(task)),
    waiting: active.filter(task => task.status === "waiting" || task.status === "blocked" || hasUnknownProviderState(task) || hasUnverifiedRequirement(task)),
    fixedEvents: state.events.filter(event => Date.parse(event.start) < end && Date.parse(event.end) > start).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id)),
    completed: selectTasks(state, { view: "completed" }),
    removed: selectTasks(state, { view: "removed" }),
    providerCompleted: state.tasks.filter(task => !task.removedAt && task.status !== "done" && isProviderComplete(task)).sort(byDeadline),
  };
}
