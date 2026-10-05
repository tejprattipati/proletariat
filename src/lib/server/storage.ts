import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ActionResult, WorkspaceState } from "../types";
import { createDemoState } from "../domain/fixtures";

let database: DatabaseSync | undefined;
function db() {
  if (!database) {
    const directory = resolve(process.env.DATA_DIR || ".data");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(resolve(directory, "proletariat.sqlite"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, updated_at TEXT NOT NULL);");
  }
  return database;
}
export function readWorkspace(id: string): WorkspaceState {
  const row = db().prepare("SELECT body FROM workspaces WHERE id = ?").get(id) as { body: string } | undefined;
  if (row) { const state = JSON.parse(row.body) as WorkspaceState; state.permissions.driveWrite ??= false; state.permissions.calendarRead ??= false; state.recipes ??= []; state.conversations ??= []; state.attachments ??= []; state.taskHistory ??= []; state.canvasConfig ??= {enabled:false,time:"09:00",weekday:1}; state.dailyConfig ??= {enabled:false,time:"09:00",gmailQuery:"newer_than:1d",calendarId:"primary"}; return state; }
  const state = createDemoState(); saveWorkspace(id, state); return state;
}
export function recentDemoWorkspaces(limit = 50): string[] {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return (db().prepare("SELECT id FROM workspaces WHERE id LIKE 'demo:%' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?").all(since, limit) as {id: string}[]).map(row => row.id);
}
export function saveWorkspace(id: string, state: WorkspaceState) {
  db().prepare("INSERT INTO workspaces(id, body, updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at").run(id, JSON.stringify(state), new Date().toISOString());
}
const locks = new Map<string, Promise<unknown>>();
export async function withWorkspace<T>(id: string, operation: (state: WorkspaceState) => Promise<T>): Promise<T> {
  const prior = locks.get(id) || Promise.resolve();
  const current = prior.catch(() => undefined).then(() => operation(readWorkspace(id)));
  locks.set(id, current);
  try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
}
export function getValue<T>(key: string): T | undefined {
  const row = db().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as T : undefined;
}
export function setValue(key: string, value: unknown) { db().prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
export function deleteValue(key: string) { db().prepare("DELETE FROM kv WHERE key=?").run(key); }
export function transaction<T>(work: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try { const result = work(); db().exec("COMMIT"); return result; }
  catch (error) { db().exec("ROLLBACK"); throw error; }
}
function encryptionKey() {
  const text = process.env.TOKEN_ENCRYPTION_KEY || "";
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw new Error("Set TOKEN_ENCRYPTION_KEY to a base64-encoded 32-byte key before connecting Google.");
  return key;
}
export function setSecret(key: string, value: unknown) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  setValue(key, { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), body: encrypted.toString("base64") });
}
export function getSecret<T>(key: string): T | undefined {
  const record = getValue<{iv: string; tag: string; body: string}>(key); if (!record) return undefined;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv,"base64")); decipher.setAuthTag(Buffer.from(record.tag,"base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.body,"base64")),decipher.final()]).toString("utf8"));
}
export interface OperationRecord { key: string; fingerprint: string; status: "started" | "succeeded" | "unknown"; result?: unknown; }
export function reserveOperation(key: string, fingerprint: string): { reserved: boolean; record: OperationRecord } {
  const inserted = db().prepare("INSERT OR IGNORE INTO operations(key,fingerprint,status,updated_at) VALUES(?,?,'started',?)").run(key, fingerprint, new Date().toISOString());
  const row = db().prepare("SELECT * FROM operations WHERE key=?").get(key) as {key: string; fingerprint: string; status: OperationRecord["status"]; result?: string};
  if (row.fingerprint !== fingerprint) throw new Error("This operation key was already used for a different request.");
  return { reserved: Number(inserted.changes) === 1, record: { key, fingerprint, status: row.status, result: row.result ? JSON.parse(row.result) : undefined } };
}
export function finishOperation(key: string, result: unknown, status: OperationRecord["status"] = "succeeded") { db().prepare("UPDATE operations SET status=?,result=?,updated_at=? WHERE key=?").run(status, JSON.stringify(result), new Date().toISOString(), key); }
export function persistResult(workspaceId: string, result: ActionResult) { return transaction(()=>{result.state.version=Math.max(result.state.version,readWorkspace(workspaceId).version)+1;saveWorkspace(workspaceId,result.state);return result;}); }
export function closeDatabase() { database?.close(); database = undefined; }
