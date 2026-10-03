import type { GoogleDocument, GoogleDocumentTab } from './contracts';
import { GoogleIntegrationError } from './security';

export interface RecipeValues { title: string; context: string; person?: string; }
export interface RecipeEditPlan { revisionId: string; requests: unknown[]; replacements: number; appendedContext: boolean; appendedPerson: boolean; }

/** Deterministic merge only. Source document text is data, never executable instructions. */
export function planRecipeEdits(document: GoogleDocument, values: RecipeValues): RecipeEditPlan {
  if (!document.revisionId) throw new GoogleIntegrationError('DOCUMENT_REVISION_REQUIRED', 'The new document did not return a revision for safe personalization.', 409);
  // Avoid sequential replacement requests rewriting text injected by an earlier replacement.
  if (Object.values(values).some(value => value && /\{\{(?:title|context|person)\}\}/.test(value))) throw new GoogleIntegrationError('RECIPE_RESERVED_PLACEHOLDER', 'Supplied title, person and context cannot contain the reserved template placeholders.');
  const tabs = flatten(document.tabs ?? []);
  if (tabs.length && tabs.some(tab => !tab.tabProperties?.tabId)) throw new GoogleIntegrationError('DOCUMENT_TAB_AMBIGUOUS', 'The copied document has a tab without a stable identifier.', 409);
  const sections = tabs.length ? tabs.map(tab => ({ tabId: tab.tabProperties!.tabId!, text: extractDocumentText(tab.documentTab) })) : [{ tabId: undefined, text: extractDocumentText(document) }];
  const requests: unknown[] = [];
  let replacements = 0;
  const found = new Set<string>();
  for (const [name, value] of Object.entries({ title: values.title, context: values.context, person: values.person ?? '' })) {
    const token = `{{${name}}}`;
    const targets = sections.filter(section => section.text.includes(token));
    if (!targets.length) continue;
    found.add(name);
    replacements += targets.reduce((count, section) => count + section.text.split(token).length - 1, 0);
    const tabIds = targets.flatMap(section => section.tabId ? [section.tabId] : []);
    requests.push({ replaceAllText: { containsText: { text: token, matchCase: true }, replaceText: value, ...(tabIds.length ? { tabsCriteria: { tabIds } } : {}) } });
  }
  const appendedContext = !found.has('context');
  const appendedPerson = !!values.person && !found.has('person');
  if (appendedContext || appendedPerson) {
    const suffix = `${appendedContext ? '\n\nProvided context\n' : '\n\n'}${appendedPerson ? `Prepared for: ${values.person}\n` : ''}${appendedContext ? values.context + '\n' : ''}`;
    const tabId = sections[0]?.tabId;
    requests.push({ insertText: { endOfSegmentLocation: tabId ? { tabId } : {}, text: suffix } });
  }
  return { revisionId: document.revisionId, requests, replacements, appendedContext, appendedPerson };
}
function flatten(tabs: GoogleDocumentTab[]): GoogleDocumentTab[] { return tabs.flatMap(tab => [tab, ...flatten(tab.childTabs ?? [])]); }
/** Concatenate text runs across formatting boundaries so split placeholders are detected. */
export function extractDocumentText(value: unknown): string {
  if (Array.isArray(value)) return value.map(extractDocumentText).join('');
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  if (object.textRun && typeof object.textRun === 'object') return String((object.textRun as { content?: unknown }).content ?? '');
  return Object.entries(object).filter(([key]) => !['namedRanges', 'documentStyle', 'paragraphStyle', 'textStyle'].includes(key)).map(([, child]) => extractDocumentText(child)).join('');
}
