import { CanvasIntegration } from './index';
import type { CanvasCollectOptions, CanvasCredentials, CanvasDependencies } from './contracts';
/** Fictional, network-free fixture adapter. Never silently substituted for missing live configuration. */
export function createSyntheticCanvasAdapter() {
  const store = new Map<string, unknown>(); const calls: { url: string; method: string }[] = [];
  const credentials: CanvasCredentials = { ownerId: 'synthetic-owner', connectionId: 'synthetic-connection', accountId: '99', accountLabel: 'Fictional student', baseUrl: 'https://canvas.example.com', token: 'synthetic-token-not-valid' };
  const dependencies: CanvasDependencies = {
    allowedOrigins: [credentials.baseUrl], getOwnerId: async () => credentials.ownerId, getCredentials: async () => credentials,
    store: { get: async <T>(key: string) => structuredClone(store.get(key)) as T | undefined, set: async (key, value) => { store.set(key, structuredClone(value)); }, delete: async key => { store.delete(key); } },
    now: () => new Date('2026-10-05T12:00:00Z'), fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push({ url: url.href, method: init?.method ?? 'GET' });
      const data = url.pathname.endsWith('/profile') ? { id: 99, name: 'Fictional student' } : url.pathname === '/api/v1/courses' ? [{ id: 10, name: 'Fictional example course', workflow_state: 'available' }] : url.pathname.endsWith('/assignments') ? [{ id: 1, name: 'Review fictional project outline', description: '<p>Example coursework for a synthetic adapter demonstration.</p>', submission_types: ['online_upload'], due_at: '2026-10-09T17:00:00Z', unlock_at: null, lock_at: null, submission: { workflow_state: 'unsubmitted', user_id: 99 } }] : [];
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    },
  };
  const integration = new CanvasIntegration(dependencies);
  return { mode: 'demo' as const, synthetic: true as const, realProviderCalls: 0 as const, calls, dependencies, integration, async collect(options?: CanvasCollectOptions) { return { ...await integration.collect(options), synthetic: true as const, mode: 'demo' as const, realProviderCalls: 0 as const }; } };
}
