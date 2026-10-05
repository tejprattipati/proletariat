import type { CanvasCredentials, CanvasDependencies } from '../../src/lib/canvas/contracts';
import { CanvasIntegration } from '../../src/lib/canvas/index';
export const origin = 'https://canvas.example.com';
export const assignment = (id = 1, changes: Record<string, unknown> = {}) => ({ id, name: 'Fictional coursework', description: '<p>Read this fictional prompt.</p>', submission_types: ['online_upload'], due_at: '2026-10-09T23:59:00-04:00', unlock_at: null, lock_at: null, submission: { workflow_state: 'unsubmitted', user_id: 99 }, ...changes });
export function harness(custom?: (url: URL) => Response | undefined | Promise<Response | undefined>) {
  const values = new Map<string, unknown>(); const calls: { url: string; method: string }[] = [];
  let owner = 'synthetic-app-owner'; let credentials: CanvasCredentials | undefined = { ownerId: owner, connectionId: 'synthetic-connection', baseUrl: origin, accountId: '99', token: 'synthetic-token-not-valid' };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url: url.href, method: init?.method ?? 'GET' }); const response = await custom?.(url); if (response) return response;
    const path = url.pathname;
    const data = path.endsWith('/profile') ? { id: 99, name: 'Fictional student' } : path === '/api/v1/courses' ? [{ id: 10, name: 'Fictional course', workflow_state: 'available' }] : path.endsWith('/assignments') ? [assignment()] : [];
    return json(data);
  };
  const dependencies: CanvasDependencies = { store: { get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined, set: async (key, value) => { values.set(key, structuredClone(value)); }, delete: async key => { values.delete(key); } }, getOwnerId: async () => owner, getCredentials: async () => credentials, allowedOrigins: [origin], fetch: fetcher, now: () => new Date('2026-10-05T12:00:00Z') };
  return { integration: new CanvasIntegration(dependencies), dependencies, values, calls, setOwner(value: string) { owner = value; }, setCredentials(value?: CanvasCredentials) { credentials = value; }, getCredentials() { return credentials; } };
}
export const json = (value: unknown, status = 200, next?: string) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...(next ? { Link: `<${next}>; rel="next"` } : {}) } });
export async function finish(integration: CanvasIntegration, options: { resume?: boolean; runId?: string; maxPages?: number; timezone?: string } = {}) {
  let result = await integration.collect(options); let iterations = 0;
  while (result.hasMore && iterations++ < 50) result = await integration.collect({ resume: true, runId: result.snapshot.id, maxPages: options.maxPages, timezone: options.timezone });
  if (result.hasMore) throw new Error('Synthetic sweep exceeded iteration budget');
  return result;
}
