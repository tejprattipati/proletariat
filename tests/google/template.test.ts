import { describe, expect, it } from 'vitest';
import { planRecipeEdits } from '../../src/lib/google/template';
import type { GoogleDocument } from '../../src/lib/google/contracts';
const document = (content: string): GoogleDocument => ({ documentId: 'synthetic-output', revisionId: 'synthetic-revision', tabs: [{ tabProperties: { tabId: 't.synthetic' }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content } }] } }] } } }] });
describe('deterministic document recipe merge', () => {
  it('replaces only supported exact placeholders with literal supplied data', () => {
    const plan = planRecipeEdits(document('{{title}}\nFor {{person}}\n{{context}}\n{{unsupported}}'), { title: 'Example report', person: 'Example Person', context: 'Supplied fictional context.' });
    expect(plan.replacements).toBe(3); expect(plan.appendedContext).toBe(false); expect(plan.requests).toHaveLength(3);
    expect(plan.requests).toContainEqual({ replaceAllText: { containsText: { text: '{{context}}', matchCase: true }, replaceText: 'Supplied fictional context.', tabsCriteria: { tabIds: ['t.synthetic'] } } });
    expect(JSON.stringify(plan.requests)).not.toContain('{{unsupported}}');
  });
  it('appends a visible context section when the reference has no placeholder instead of claiming copy-only personalization', () => {
    const plan = planRecipeEdits(document('Existing styled reference content.'), { title: 'Example', person: 'Example Person', context: 'Specific fictional facts.' });
    expect(plan.replacements).toBe(0); expect(plan.appendedContext).toBe(true); expect(plan.appendedPerson).toBe(true);
    expect(plan.requests).toEqual([{ insertText: { endOfSegmentLocation: { tabId: 't.synthetic' }, text: '\n\nProvided context\nPrepared for: Example Person\nSpecific fictional facts.\n' } }]);
  });
  it('detects a placeholder split across differently formatted text runs', () => {
    const source = document(''); source.tabs![0].documentTab!.body = { content: [{ paragraph: { elements: [{ textRun: { content: '{{con' } }, { textRun: { content: 'text}}' } }] } }] };
    const plan = planRecipeEdits(source, { title: 'Example', context: 'Literal context' });
    expect(plan.replacements).toBe(1); expect(plan.appendedContext).toBe(false);
  });
  it('rejects replacement text that would cause sequential placeholder expansion', () => {
    expect(() => planRecipeEdits(document('{{context}}'), { title: 'Example', context: 'Literal {{person}} token' })).toThrow('reserved template placeholders');
  });
  it('requires a revision guard and stable tab selection', () => {
    expect(() => planRecipeEdits({ documentId: 'synthetic' }, { title: 'Example', context: 'Facts' })).toThrow('revision');
    expect(() => planRecipeEdits({ documentId: 'synthetic', revisionId: 'r1', tabs: [{ documentTab: {} }] }, { title: 'Example', context: 'Facts' })).toThrow('stable identifier');
  });
});
