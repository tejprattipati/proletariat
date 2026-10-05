import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import type { DailySource } from '../types';
import type { CanvasCollectOptions, CanvasCoverageDetail, CanvasDependencies, CanvasFamily, CanvasItem, CanvasReadResult, CanvasReport } from './contracts';
import { assignmentSource, externalId, hash, object, objects, plainText, string, type CanvasObject, type ClassifyContext } from './classify';
import { CanvasIntegrationError, CanvasTransport, approvedOrigin } from './transport';
export * from './contracts';
export { CanvasIntegrationError, verifyCanvasConnection, approvedOrigin } from './transport';
interface Segment { url: string; family: CanvasFamily; courseId: string; courseName: string; detail?: 'assignment' | 'quiz' | 'discussion' | 'page'; aliases?: string[]; requirement?: CanvasObject; moduleItemId?: string; extraRequirements?: CanvasObject[]; }
interface Baseline { items: Record<string, CanvasItem>; exhaustiveAt?: string; successful: Record<string, string>; gaps: string[]; }
interface Job {
  id: string; connectionId: string; createdAt: string; updatedAt: string; timezone: string; baseline: Baseline;
  queue: Segment[]; failed: Segment[]; visited: string[]; sources: Record<string, DailySource>; items: Record<string, CanvasItem>;
  coverage: Record<string, CanvasCoverageDetail>; aliases: Record<string, string>; identityVerified: boolean; done: boolean; calls: number;
}
const FAMILY_NAMES: CanvasFamily[] = ['assignments', 'quizzes', 'discussions', 'modules'];
const assignmentQuery = 'include[]=submission&include[]=overrides&include[]=assignment_visibility&override_assignment_dates=true&per_page=100';
const coverageKey = (segment: Segment) => `${segment.courseId}:${segment.family}`;
/** Only read methods exist. Lead serializes collection under its per-owner workspace lock. */
export class CanvasIntegration {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private deps: CanvasDependencies) {}
  collect(options: CanvasCollectOptions = {}): Promise<CanvasReadResult> {
    const run = this.tail.then(() => this.read(options)); this.tail = run.catch(() => undefined); return run;
  }
  private async read(options: CanvasCollectOptions): Promise<CanvasReadResult> {
    if (options.timezone && !DateTime.now().setZone(options.timezone).isValid) throw new CanvasIntegrationError('CANVAS_TIMEZONE_INVALID', 'Choose a valid workspace timezone.');
    if (options.runId && (options.runId.length > 200 || !/^[A-Za-z0-9:_-]+$/.test(options.runId))) throw new CanvasIntegrationError('CANVAS_RUN_INVALID', 'Canvas run ID is invalid.');
    const credentials = await this.deps.getCredentials();
    if (!credentials) throw new CanvasIntegrationError('CANVAS_NOT_CONNECTED', 'Connect Canvas explicitly before reading coursework.', 401);
    const transport = new CanvasTransport(this.deps, credentials); await transport.guard();
    const baseUrl = approvedOrigin(credentials.baseUrl, this.deps.allowedOrigins);
    const prefix = `canvas:${hash({ owner: credentials.ownerId, host: baseUrl, account: credentials.accountId }).slice(0, 32)}`;
    const namespace = `${prefix}:grant:${credentials.connectionId}`;
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const latest = await this.deps.store.get<string>(`${namespace}:latest`);
    let job = options.resume || options.runId ? await this.deps.store.get<Job>(`${namespace}:job:${options.runId ?? latest ?? ''}`) : undefined;
    if (options.resume && !job) throw new CanvasIntegrationError('CANVAS_CHECKPOINT_MISSING', 'No checkpoint exists for this Canvas connection. Start a new read.', 409);
    if (!job) {
      const baseline = await this.deps.store.get<Baseline>(`${prefix}:baseline`) ?? { items: {}, successful: {}, gaps: [] };
      job = { id: options.runId ?? randomUUID(), connectionId: credentials.connectionId, createdAt: now, updatedAt: now, timezone: options.timezone ?? 'UTC', baseline, queue: [{ url: '/api/v1/courses?enrollment_type=student&enrollment_state=active&state[]=available&include[]=enrollments&per_page=100', family: 'courses', courseId: 'all', courseName: 'Current courses' }], failed: [], visited: [], sources: {}, items: {}, coverage: {}, aliases: {}, identityVerified: false, done: false, calls: 0 };
    }
    const previousCalls = job.calls;
    const jobKey = `${namespace}:job:${job.id}`;
    if (!job.identityVerified) {
      const profile = object((await transport.get('/api/v1/users/self/profile')).data);
      if (externalId(profile.id) !== credentials.accountId) throw new CanvasIntegrationError('CANVAS_ACCOUNT_MISMATCH', 'Canvas token identifies a different account; reconnect explicitly.', 403);
      job.identityVerified = true;
    }
    if (job.done && job.failed.length && options.resume) { job.queue.push(...job.failed); job.failed = []; job.done = false; }
    const maxPages = Math.min(10, Math.max(1, Math.trunc(options.maxPages ?? 5)));
    if (!Number.isFinite(maxPages)) throw new CanvasIntegrationError('CANVAS_LIMIT_INVALID', 'maxPages must be a finite integer.');
    for (let pageIndex = 0; pageIndex < maxPages && job.queue.length; pageIndex++) {
      await transport.guard(); const segment = job.queue[0]; const key = coverageKey(segment);
      job.coverage[key] ??= { courseId: segment.courseId, courseName: segment.courseName, family: segment.family, status: 'partial', discovered: 0, read: 0, metadataRead: 0, contentRead: 0, submissionRead: 0, skipped: 0, gaps: [], lastSuccessfulReadAt: job.baseline.successful[key] };
      const before: Job = structuredClone(job);
      try {
        const pageUrl = transport.url(segment.url).href + (segment.detail === 'page' ? `#module=${segment.moduleItemId}` : '');
        if (job.visited.includes(pageUrl)) throw new CanvasIntegrationError('CANVAS_PAGE_CYCLE', 'Canvas pagination repeated an already applied page.');
        if (job.visited.length >= 5000 || Object.keys(job.sources).length >= 5000) throw new CanvasIntegrationError('CANVAS_SWEEP_LIMIT', 'Canvas sweep reached its 5,000-page/item bound; coverage remains partial.');
        const page = await transport.get(segment.url);
        if (!segment.detail && !Array.isArray(page.data)) throw new CanvasIntegrationError('CANVAS_RESPONSE_INVALID', 'Canvas list endpoint did not return an array.', 502);
        job.queue.shift(); job.visited.push(pageUrl);
        const rawItems = segment.detail ? [object(page.data)] : objects(page.data);
        const coverage = job.coverage[key]; coverage.discovered += rawItems.length; coverage.lastReadAt = now;
        for (const raw of rawItems) {
          this.apply(job, raw, segment, { prefix, baseUrl, courseId: segment.courseId, courseName: segment.courseName, accountId: credentials.accountId, timezone: job.timezone, now });
          coverage.metadataRead = (coverage.metadataRead ?? 0) + 1;
          const assignmentRead = segment.detail === 'assignment' || segment.family === 'assignments';
          const bodyRead = segment.detail === 'page' ? typeof raw.body === 'string' : assignmentRead && (typeof raw.description === 'string' || raw.description === null);
          if (bodyRead && raw.locked_for_user !== true) { coverage.contentRead = (coverage.contentRead ?? 0) + 1; coverage.read++; }
          if (assignmentRead && Object.keys(object(raw.submission)).length) coverage.submissionRead = (coverage.submissionRead ?? 0) + 1;
        }
        if (page.next) { if (job.visited.includes(page.next)) throw new CanvasIntegrationError('CANVAS_PAGE_CYCLE', 'Canvas pagination formed a cycle.'); job.queue.unshift({ ...segment, url: page.next }); }
        if (Object.values(job.sources).reduce((sum, source) => sum + source.text.length, 0) > 10_000_000 || job.queue.length > 5000) throw new CanvasIntegrationError('CANVAS_SWEEP_LIMIT', 'Canvas content/checkpoint bound reached; coverage remains partial.');
        coverage.status = !page.next && !coverage.gaps.length && !job.queue.some(item => coverageKey(item) === key) ? 'complete' : 'partial';
        delete coverage.error;
        if (coverage.status === 'complete') coverage.lastSuccessfulReadAt = now;
        await transport.guard(); job.updatedAt = now; job.calls += transport.apiCalls; transport.apiCalls = 0;
        // Sources, aliases and next-page cursor are one durable record; replay cannot skip a page.
        await this.deps.store.set(jobKey, job); await this.deps.store.set(`${namespace}:latest`, job.id);
      } catch (error) {
        job = before; job.queue.shift(); job.failed.push(segment);
        const coverage = job.coverage[key]; coverage.status = coverage.discovered ? 'partial' : 'failed'; coverage.error = error instanceof CanvasIntegrationError ? error.message : 'Canvas read failed; resume the saved segment.';
        if (error instanceof CanvasIntegrationError && ['CANVAS_OWNER_MISMATCH', 'CANVAS_CONNECTION_CHANGED'].includes(error.code)) throw error;
        job.calls += transport.apiCalls; transport.apiCalls = 0;
        await this.deps.store.set(jobKey, job); await this.deps.store.set(`${namespace}:latest`, job.id);
      }
    }
    job.done = !job.queue.length; job.updatedAt = now;
    // A family is complete only after all its independently paginated detail reads have finished.
    for (const [key, coverage] of Object.entries(job.coverage)) if (!job.queue.some(item => coverageKey(item) === key) && !job.failed.some(item => coverageKey(item) === key) && !coverage.gaps.length) { coverage.status = 'complete'; coverage.lastSuccessfulReadAt = coverage.lastReadAt; }
    const coverage = Object.values(job.coverage); const exhaustive = job.done && !job.failed.length && coverage.every(item => item.status === 'complete');
    const report: CanvasReport = { id: job.id, initial: !Object.keys(job.baseline.items).length, newItems: [], changedItems: [], coverage, exhaustiveBaselineAdvanced: exhaustive };
    for (const item of Object.values(job.items).filter(item => item.actionable)) {
      const prior = job.baseline.items[item.id];
      if (!prior) report.newItems.push({ ...item, discoveredAfterGap: !report.initial && job.baseline.gaps.some(key => key.startsWith(`${item.courseId}:`)) });
      else { const fields = ['dueAt', 'unlockAt', 'lockAt', 'state', 'title'].filter(field => item[field as keyof CanvasItem] !== prior[field as keyof CanvasItem]); if (fields.length) report.changedItems.push({ id: item.id, before: prior, after: item, fields }); }
    }
    await transport.guard();
    if (job.done) {
      const previous = await this.deps.store.get<Baseline>(`${prefix}:baseline`) ?? job.baseline;
      const successful = { ...previous.successful }; for (const entry of coverage) if (entry.status === 'complete' && entry.lastSuccessfulReadAt) successful[`${entry.courseId}:${entry.family}`] = entry.lastSuccessfulReadAt;
      // Successful segments keep their known identities; unseen objects are never inferred deleted.
      await this.deps.store.set<Baseline>(`${prefix}:baseline`, { items: { ...previous.items, ...job.items }, successful, gaps: coverage.filter(entry => entry.status !== 'complete').map(entry => `${entry.courseId}:${entry.family}`), exhaustiveAt: exhaustive ? now : previous.exhaustiveAt });
    }
    await this.deps.store.set(jobKey, job); await this.deps.store.set(`${namespace}:latest`, job.id);
    const sources = Object.values(job.sources);
    const snapshot = { id: job.id, createdAt: job.createdAt, updatedAt: job.updatedAt, status: exhaustive ? 'complete' as const : sources.length ? 'partial' as const : 'failed' as const, sources, coverage, newTaskIds: [], changedTaskIds: [], initial: report.initial, summary: `${report.initial ? 'Initial inventory' : 'Refresh'}: ${sources.length} source records, ${report.newItems.length} newly discovered obligations, ${report.changedItems.length} changed obligations; ${coverage.filter(item => item.status !== 'complete').length} incomplete source families. No model calls or Canvas writes.` };
    return { snapshot, report, hasMore: !!job.queue.length, apiCalls: job.calls - previousCalls, modelCalls: 0 };
  }
  private enqueue(job: Job, segment: Segment): void {
    const already = job.queue.find(item => item.url === segment.url);
    if (already) { already.aliases = [...new Set([...(already.aliases ?? []), ...(segment.aliases ?? [])])]; if (segment.requirement && segment.moduleItemId !== already.moduleItemId) already.extraRequirements = [...(already.extraRequirements ?? []), segment.requirement, ...(segment.extraRequirements ?? [])]; return; }
    if (segment.detail === 'page' || !job.visited.some(url => new URL(url).pathname + new URL(url).search === new URL(segment.url, 'https://canvas.example.com').pathname + new URL(segment.url, 'https://canvas.example.com').search)) job.queue.push(segment);
  }
  private apply(job: Job, raw: CanvasObject, segment: Segment, context: ClassifyContext): void {
    const coverage = job.coverage[coverageKey(segment)];
    if (segment.detail === 'page') { if (typeof raw.body !== 'string') coverage.gaps.push(`Module item ${segment.moduleItemId}: page body was not read`); if (raw.locked_for_user === true) coverage.gaps.push(`Module item ${segment.moduleItemId}: page content is locked`); for (const requirement of [segment.requirement ?? {}, ...(segment.extraRequirements ?? [])]) this.moduleRequirement(job, { ...requirement, description: raw.body }, { ...segment, moduleItemId: externalId(requirement.id) ?? segment.moduleItemId }, context); return; }
    const id = externalId(raw.id);
    if (!id) { coverage.gaps.push('Provider returned an item without a valid stable identity.'); return; }
    if (segment.family === 'courses') {
      const name = (string(raw.name) ?? `Course ${id}`).slice(0, 300);
      if (raw.workflow_state && raw.workflow_state !== 'available') { coverage.skipped++; return; }
      for (const family of FAMILY_NAMES) this.enqueue(job, { url: `/api/v1/courses/${id}/${family === 'discussions' ? 'discussion_topics' : family}?${family === 'assignments' ? assignmentQuery : 'per_page=100'}`, family, courseId: id, courseName: name });
      return;
    }
    if (segment.family === 'modules' && !segment.detail) {
      if (raw.state === 'locked') coverage.gaps.push(`Module ${id}: locked for the current user`);
      this.enqueue(job, { url: `/api/v1/courses/${segment.courseId}/modules/${id}/items?per_page=100`, family: 'module_items', courseId: segment.courseId, courseName: segment.courseName }); return;
    }
    if (segment.family === 'module_items' && !segment.detail) {
      const alias = `${context.prefix}:${context.courseId}:module_item:${id}`; const linkedId = externalId(raw.content_id); const type = string(raw.type);
      if (['Assignment', 'Quiz', 'Discussion'].includes(type ?? '') && linkedId) {
        const kind = type === 'Assignment' ? 'assignment' : type === 'Quiz' ? 'quiz' : 'discussion';
        const known = job.aliases[`${context.prefix}:${context.courseId}:${kind}:${linkedId}`];
        if (known) { this.alias(job, known, [alias]); const requirement = object(raw.completion_requirement); if (!job.items[known].actionable || requirement.type === 'min_score' && requirement.completed !== true) this.moduleRequirement(job, raw, segment, context, known); }
        else this.enqueue(job, { url: `/api/v1/courses/${context.courseId}/${kind === 'assignment' ? 'assignments' : kind === 'quiz' ? 'quizzes' : 'discussion_topics'}/${linkedId}${kind === 'assignment' ? `?${assignmentQuery}` : ''}`, family: 'module_items', courseId: context.courseId, courseName: context.courseName, detail: kind, aliases: [alias], requirement: raw, moduleItemId: id });
        return;
      }
      const requirement = object(raw.completion_requirement); const requirementType = string(requirement.type);
      if (type === 'Page' && typeof raw.page_url === 'string') {
        const path = encodeURIComponent(raw.page_url);
        this.enqueue(job, { url: `/api/v1/courses/${context.courseId}/pages/${path}`, family: 'module_items', courseId: context.courseId, courseName: context.courseName, detail: 'page', aliases: [alias], requirement: raw, moduleItemId: id }); return;
      }
      if (requirementType) coverage.gaps.push(`Module item ${id}: ${type ?? 'unknown'} requirement content is unsupported or unresolved`); else coverage.skipped++;
      return;
    }
    if (segment.detail !== 'assignment' && (segment.family === 'quizzes' || segment.family === 'discussions' || segment.detail === 'quiz' || segment.detail === 'discussion')) {
      const kind = segment.family === 'quizzes' || segment.detail === 'quiz' ? 'quiz' : 'discussion';
      const assignmentId = externalId(raw.assignment_id) ?? externalId(object(raw.assignment).id);
      const aliases = [...(segment.aliases ?? []), `${context.prefix}:${context.courseId}:${kind}:${id}`];
      if (assignmentId) {
        const key = `${context.prefix}:${context.courseId}:assignment:${assignmentId}`;
        if (job.items[key]) { this.alias(job, key, aliases); job.items[key].kind = kind; for (const requirement of [segment.requirement, ...(segment.extraRequirements ?? [])]) if (requirement && (!job.items[key].actionable || object(requirement.completion_requirement).type === 'min_score')) this.moduleRequirement(job, requirement, { ...segment, moduleItemId: externalId(requirement.id) ?? segment.moduleItemId }, context, key); }
        else this.enqueue(job, { url: `/api/v1/courses/${context.courseId}/assignments/${assignmentId}?${assignmentQuery}`, family: segment.family, courseId: context.courseId, courseName: context.courseName, detail: 'assignment', aliases, requirement: segment.requirement, moduleItemId: segment.moduleItemId, extraRequirements: segment.extraRequirements });
      } else if (kind === 'quiz' && !['practice_quiz', 'survey'].includes(string(raw.quiz_type) ?? '')) coverage.gaps.push(`Quiz ${id}: no verified underlying assignment or submission identity`);
      else if (segment.requirement) this.moduleRequirement(job, { ...segment.requirement, description: raw.message ?? raw.description }, segment, context);
      else coverage.skipped++;
      return;
    }
    const value = assignmentSource(raw, context); if (!value) return;
    job.items[value.item.id] = value.item; job.sources[value.source.id] = value.source;
    this.alias(job, value.item.id, [...value.item.aliases, ...(segment.aliases ?? [])]);
    coverage.gaps = [...new Set([...coverage.gaps.filter(gap => !gap.startsWith(`${value.item.id}:`)), ...value.gaps])];
    for (const requirement of [segment.requirement, ...(segment.extraRequirements ?? [])]) if (requirement && (!value.item.actionable || object(requirement.completion_requirement).type === 'min_score')) this.moduleRequirement(job, requirement, { ...segment, moduleItemId: externalId(requirement.id) ?? segment.moduleItemId }, context, value.item.id);
  }
  private alias(job: Job, key: string, aliases: string[]): void {
    const item = job.items[key]; if (!item) return;
    item.aliases = [...new Set([...item.aliases, ...aliases])];
    for (const alias of item.aliases) {
      if (job.aliases[alias] && job.aliases[alias] !== key) throw new CanvasIntegrationError('CANVAS_ALIAS_CONFLICT', 'Provider links identify conflicting obligations. Preserve the originals and review the linkage.');
      job.aliases[alias] = key;
    }
    for (const obligation of job.sources[key]?.obligations ?? []) obligation.aliases = item.aliases;
  }
  private moduleRequirement(job: Job, raw: CanvasObject, segment: Segment, context: ClassifyContext, canonicalKey?: string): void {
    const requirement = object(raw.completion_requirement); const type = string(requirement.type); const id = segment.moduleItemId ?? externalId(raw.id);
    if (!id) return;
    const coverage = job.coverage[coverageKey(segment)];
    const supported = ['must_view', 'must_mark_done', 'must_contribute', 'min_score'];
    if (type && !supported.includes(type)) { coverage.gaps.push(`Module item ${id}: completion requirement ${type} cannot be resolved`); return; }
    const key = canonicalKey ?? `${context.prefix}:${context.courseId}:module_item:${id}`; const title = (string(raw.title) ?? '(Untitled module item)').slice(0, 1000);
    const text = plainText(raw.description); const state = requirement.completed === true ? 'completed' as const : requirement.completed === false ? 'incomplete' as const : 'unknown' as const;
    const url = `${context.baseUrl}/courses/${context.courseId}/modules/items/${id}`;
    const source = job.sources[key] ?? { id: key, provider: 'canvas' as const, externalId: id, title, text: text.slice(0, 40_000), truncated: text.length > 40_000, url, readAt: context.now, obligations: [] };
    if (type) {
      const obligation = { itemId: `module_requirement:${id}`, title, categories: ['School'], providerState: state, completed: state === 'completed', aliases: [key, `${context.prefix}:${context.courseId}:module_item:${id}`], nextAction: type === 'must_view' ? 'Read required module content' : type === 'min_score' ? 'Review unmet module score requirement' : 'Complete module requirement', notes: `Verified ${type} requirement in ${context.courseName}. This is module completion work; no submission deadline is inferred.` };
      source.obligations = [...(source.obligations ?? []).filter(item => item.itemId !== obligation.itemId), obligation];
      if (state === 'unknown') coverage.gaps.push(`Module item ${id}: completion state is unknown`);
    } else coverage.skipped++;
    source.version = hash({ title, text: source.text, type, state }); job.sources[key] = source;
    const reportKey = canonicalKey && type ? `${key}:module_requirement:${id}` : key;
    if (!canonicalKey || type) job.items[reportKey] = { id: reportKey, courseId: context.courseId, courseName: context.courseName, externalId: id, kind: 'module_requirement', title, url, state, actionable: !!type, aliases: [key], version: source.version };
  }
}
