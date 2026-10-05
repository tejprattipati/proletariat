import { isActiveTask } from './taskViews';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Copy, FileText, Folder, Layers3, Pencil, Plus, Sparkles } from 'lucide-react';
import type { Recipe, Resource } from '../lib/types';
import { Badge, Button, EmptyState, Field, Modal, SafeLink, type ScreenProps } from './ui';

export function Recipes({ state, run, busy, requestedSource, clearRequestedSource }: ScreenProps & { requestedSource: Resource | null; clearRequestedSource: () => void }) {
  const [editing, setEditing] = useState<Recipe | 'new' | null>(null);
  const [selectedSource, setSelectedSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Resource | null>(null);
  const [reviewOutcome, setReviewOutcome] = useState(false);
  const recipes = state.recipes || [];
  const currentResources = state.resources.filter(r => r.mode === state.settings.mode);
  const documents = currentResources.filter(r => r.kind === 'document');
  const folders = currentResources.filter(r => r.kind === 'folder');
  const allowed = state.permissions.driveRead && state.permissions.docsWrite && state.permissions.driveWrite;
  useEffect(() => {
    if (requestedSource) { setSelectedSource(requestedSource.id); setEditing('new'); setError(null); setCreated(null); setReviewOutcome(false); }
  }, [requestedSource]);
  function close() { setEditing(null); clearRequestedSource(); setError(null); }
  function open(recipe?: Recipe) { setEditing(recipe || 'new'); setSelectedSource(recipe?.referenceResourceId || ''); setError(null); setCreated(null); setReviewOutcome(false); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const shouldRun = submitter?.value !== 'save';
    const priorRunIds = new Set(state.runs.map(receipt => receipt.id));
    const name = String(form.get('name') || '').trim();
    const referenceResourceId = String(form.get('referenceResourceId') || '');
    const destinationFolderId = String(form.get('destinationFolderId') || '');
    if (!name || !referenceResourceId || !destinationFolderId) { setError('Give your recipe a name, a reference document, and a destination folder.'); return; }
    const reference = currentResources.find(r => r.id === referenceResourceId);
    const destination = currentResources.find(r => r.id === destinationFolderId);
    if (!reference || !destination) { setError('The selected reference or destination is no longer available. Choose it again.'); return; }
    // Bind the user's explicitly chosen resources before persisting the reusable recipe.
    if (!reference.bound && !await run('resource.bind', { id: referenceResourceId, role: 'reference' })) return;
    if (!destination.bound && !await run('resource.bind', { id: destinationFolderId, role: 'output' })) return;
    const agentId = String(form.get('agentId') || '');
    const changed = editing === 'new' || !editing || editing.name !== name || editing.referenceResourceId !== referenceResourceId || editing.destinationFolderId !== destinationFolderId || (editing.agentId || '') !== agentId;
    let recipeId = editing && editing !== 'new' ? editing.id : undefined;
    if (changed) {
      const saved = await run(recipeId ? 'recipe.update' : 'recipe.create', { ...(recipeId ? { id: recipeId } : {}), name, referenceResourceId, destinationFolderId, agentId });
      if (!saved) return;
      recipeId = saved.entityId || recipeId;
      const savedRecipe = saved.state.recipes?.find(r => r.id === recipeId);
      if (savedRecipe) setEditing(savedRecipe);
    }
    if (!shouldRun) { close(); return; }
    if (!recipeId) { setError('The backend did not return a saved recipe ID. Refresh the workspace before creating a document.'); return; }
    const result = await run('recipe.run', { id: recipeId, title: String(form.get('title') || '').trim(), context: String(form.get('context') || '').trim(), person: String(form.get('person') || '').trim(), taskId: form.get('taskId') || undefined });
    if (!result) { setReviewOutcome(true); setError('Creation was not confirmed. Check Activity and the destination folder for a recorded or partial output before starting another run.'); return; }
    const receipt = result.state.runs.find(r => r.recipeId === recipeId && !priorRunIds.has(r.id) && r.changedResourceIds?.length);
    const outputId = receipt?.changedResourceIds?.[0] || result.entityId;
    const output = result.state.resources.find(r => r.id === outputId);
    if (output && receipt?.status === 'succeeded') { setCreated(output); close(); }
    else { setReviewOutcome(true); setError('The run needs review. Open Activity for the recorded outcome and any partially created document before retrying.'); }
  }
  return <>
    <section className="panel recipes-panel"><div className="recipes-heading"><span className="recipe-symbol"><Layers3 size={21} /></span><div><span className="eyebrow">GOOD STRUCTURE, REUSED</span><h2>Start from work you trust</h2><p>Save a document recipe. Create a new copy in the right folder, every time.</p></div><Button onClick={() => open()}><Plus size={15} />New recipe</Button></div>
      {recipes.length > 0 && <div className="recipe-cards">{recipes.map(recipe => {
        const reference = state.resources.find(r => r.id === recipe.referenceResourceId);
        const destination = state.resources.find(r => r.id === recipe.destinationFolderId);
        return <article className="recipe-card" key={recipe.id}><div className="recipe-card-header"><span><Copy size={17} /></span><h3>{recipe.name}</h3><button className="icon-button" aria-label={`Edit ${recipe.name}`} onClick={() => open(recipe)}><Pencil size={14} /></button></div><div className="recipe-route"><span><FileText size={12} />{reference?.name || 'Reference unavailable'}</span><ArrowRight size={13} /><span><Folder size={12} />{destination?.name || 'Folder unavailable'}</span></div><div className="recipe-card-footer"><Badge>Saved recipe</Badge><Button variant="ghost" onClick={() => open(recipe)} disabled={!reference || !destination}>Use recipe<ArrowRight size={13} /></Button></div></article>;
      })}</div>}
      {!recipes.length && <div className="recipe-intro"><Copy size={15} /><p>Choose <strong>Use as template</strong> on a document below, or start a recipe here. Your reference stays intact.</p></div>}
    </section>
    {created && <div className="recipe-created" role="status"><span><Check size={17} /></span><div><strong>{created.mode === 'demo' ? 'Synthetic document created' : 'New document created'}</strong><SafeLink url={created.url}>{created.name}</SafeLink><p>Check Activity for the exact output, permissions, and usage receipt.</p></div><button className="text-button" onClick={() => setCreated(null)}>Dismiss</button></div>}
    {editing && <Modal wide title={editing === 'new' ? 'Use this as a template' : `Use ${editing.name}`} subtitle="A saved reference, an explicit destination, and a new document each run." onClose={close}><form className="form-stack" onSubmit={submit}>
      <Field label="Recipe name"><input name="name" required maxLength={150} placeholder="Client project brief" defaultValue={editing === 'new' ? requestedSource ? `${requestedSource.name} recipe` : '' : editing.name} /></Field>
      <div className="form-grid"><Field label="Reference document"><select name="referenceResourceId" required value={selectedSource} onChange={e => setSelectedSource(e.target.value)}><option value="">Choose a document</option>{documents.map(r => <option key={r.id} value={r.id}>{r.name}{r.bound ? '' : ' · bind on save'}</option>)}</select></Field><Field label="Destination folder"><select name="destinationFolderId" required defaultValue={editing === 'new' ? '' : editing.destinationFolderId}><option value="">Choose a folder</option>{folders.map(r => <option key={r.id} value={r.id}>{r.name}{r.bound ? '' : ' · bind on save'}</option>)}</select></Field></div>
      {(!documents.length || !folders.length) && <p className="inline-help">Browse Drive or bind a document and folder before creating a recipe. The reference must be a document, and the destination must be a folder.</p>}
      <Field label="Agent (optional)"><select name="agentId" defaultValue={editing === 'new' ? '' : editing.agentId || ''}><option value="">No assigned agent</option>{state.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      <div className="recipe-run-fields"><div><Sparkles size={16} /><h3>This document</h3><Badge tone={state.settings.mode === 'live' ? 'green' : 'orange'}>{state.settings.mode}</Badge></div><Field label="New document title"><input name="title" required maxLength={250} placeholder="Project brief — new engagement" /></Field><Field label="Person or organization (optional)"><input name="person" maxLength={500} placeholder="Who is this document for?" /></Field><Field label="Context to include"><textarea name="context" rows={4} maxLength={30000} required placeholder="The specifics for this document: goals, constraints, background, and next steps…" /></Field><Field label="Link to a task (optional)"><select name="taskId"><option value="">No linked task</option>{state.tasks.filter(isActiveTask).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field></div>
      <div className="recipe-method"><ShieldIcon /><p><strong>Deterministic template merge.</strong> A native copy preserves the reference’s structure. Supported <code>{'{{title}}'}</code>, <code>{'{{person}}'}</code>, and <code>{'{{context}}'}</code> placeholders are replaced. If there is no context placeholder, a labeled context section is appended. Existing prose is not automatically rewritten. Demo copies preserve synthetic reference text.</p></div>
      {!allowed && <p className="inline-help">Creating a document requires Drive read, template creation, and Docs write permissions. Enable them in <a href="#connections" onClick={close}>Connections</a>. You can save the recipe first.</p>}
      {error && <p className="inline-alert" role="alert">{error}</p>}{reviewOutcome && <a className="button button-secondary" href="#activity" onClick={close}>Review Activity<ArrowRight size={14} /></a>}
      <div className="form-actions"><Button type="button" onClick={close}>Cancel</Button><Button name="intent" value="save" type="submit" formNoValidate disabled={!!busy || !state.permissions.driveRead}>Save recipe only</Button><Button name="intent" value="run" type="submit" variant="primary" loading={busy === 'recipe.run'} disabled={!!busy || !allowed || reviewOutcome}><Copy size={15} />Create document</Button></div>
    </form></Modal>}
  </>;
}
function ShieldIcon() { return <FileText size={17} />; }
