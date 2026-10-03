import type { ActionRequest, PermissionKey, Resource, Run, WorkspaceState } from '../types';
import type { GoogleStore, OperationRecord } from './contracts';
import { GoogleProvider } from './provider';
import { SCOPES } from './oauth';
import { GoogleIntegrationError, canonicalDriveUrl, content, fingerprint, stableResourceId, text } from './security';
import { planRecipeEdits, type RecipeEditPlan, type RecipeValues } from './template';

type Outcome = OperationRecord & { replayed?: boolean };
interface RecipeDependencies {
  provider: GoogleProvider;
  store: GoogleStore;
  now: () => Date;
  assert: (...keys: PermissionKey[]) => Promise<void>;
  requireBinding: (kind: string, id: string) => Promise<void>;
  operation: (key: string, data: unknown, keys: PermissionKey[], write: () => Promise<string>) => Promise<Outcome>;
}
export interface RecipeRunResult {
  entityId?: string;
  message: string;
  status: 'succeeded' | 'failed' | 'unknown';
  writes: number;
  receipt: Pick<Run, 'sourceIds' | 'recipeId' | 'taskId' | 'agentId' | 'changedResourceIds'>;
}
export async function runGoogleRecipe(state: WorkspaceState, action: ActionRequest, deps: RecipeDependencies): Promise<RecipeRunResult> {
  const p = action.payload ?? {};
  const requestId = text(action.requestId, 'requestId', 200);
  const recipe = state.recipes?.find(item => item.id === p.id);
  if (!recipe) throw new GoogleIntegrationError('RECIPE_NOT_FOUND', 'Document recipe was not found.', 404);
  const source = state.resources.find(resource => resource.id === recipe.referenceResourceId);
  const destination = state.resources.find(resource => resource.id === recipe.destinationFolderId);
  if (!source?.bound || source.mode !== 'live' || source.kind !== 'document' || !source.providerId || !destination?.bound || destination.mode !== 'live' || destination.kind !== 'folder' || !destination.providerId) throw new GoogleIntegrationError('RECIPE_BINDING_REQUIRED', 'Bind a live reference document and a live destination folder before running this recipe.', 403);
  const taskId = typeof p.taskId === 'string' ? text(p.taskId, 'taskId', 200) : undefined;
  if (taskId && !state.tasks.some(task => task.id === taskId)) throw new GoogleIntegrationError('TASK_NOT_FOUND', 'The task linked to this recipe was not found.', 404);
  const values: RecipeValues = { title: text(p.title, 'title', 300), context: content(p.context, 'context', 100_000), ...(typeof p.person === 'string' && p.person.trim() ? { person: text(p.person, 'person', 300) } : {}) };
  if (!values.context.trim()) throw new GoogleIntegrationError('RECIPE_CONTEXT_REQUIRED', 'Supply context to personalize the new document.');
  if (Object.values(values).some(value => value && /\{\{(?:title|context|person)\}\}/.test(value))) throw new GoogleIntegrationError('RECIPE_RESERVED_PLACEHOLDER', 'Supplied title, person and context cannot contain the reserved template placeholders.');
  const required: PermissionKey[] = ['driveRead', 'driveWrite', 'docsWrite'];
  await deps.assert(...required);
  await deps.requireBinding('resource', source.id);
  await deps.requireBinding('resource', destination.id);
  // Preflight all scopes before creating any output, then recheck them at each write.
  await deps.provider.transport.authorize([SCOPES.driveRead, SCOPES.driveWrite, SCOPES.docsWrite]);
  const [sourceFile, destinationFile] = await Promise.all([deps.provider.getFile(source.providerId, true), deps.provider.getFile(destination.providerId, true)]);
  if (sourceFile.mimeType !== 'application/vnd.google-apps.document' || destinationFile.mimeType !== 'application/vnd.google-apps.folder') throw new GoogleIntegrationError('RECIPE_BINDING_CHANGED', 'The reference or destination no longer has the required Google file type.', 409);
  const inputs = { recipeId: recipe.id, sourceId: source.providerId, destinationId: destination.providerId, ...values, taskId };
  const receipt: RecipeRunResult['receipt'] = { sourceIds: [source.id, destination.id], recipeId: recipe.id, taskId, agentId: recipe.agentId, changedResourceIds: [] };
  const copied = await deps.operation(`recipe-copy:${requestId}`, inputs, required, () => deps.provider.copyDocument(source.providerId!, destination.providerId!, values.title, fingerprint({ requestId, recipeId: recipe.id })));
  if (copied.status !== 'accepted' || !copied.externalId) return { message: copied.error ?? 'Copy outcome is unconfirmed. Reconcile Google Drive before creating another copy.', status: copied.status === 'failed' ? 'failed' : 'unknown', writes: 0, receipt };
  const outputId = copied.externalId;
  const resource: Resource = { id: stableResourceId(outputId), providerId: outputId, name: values.title, kind: 'document', parentId: destination.id, url: canonicalDriveUrl(outputId, 'document'), role: 'output', bound: true, mode: 'live', modifiedAt: deps.now().toISOString() };
  if (!state.resources.some(item => item.id === resource.id)) state.resources.push(resource);
  receipt.changedResourceIds = [resource.id];
  let writes = copied.replayed ? 0 : 1;
  // The durable copy operation already contains its external ID before any personalization request.
  // Record the output in workspace state even when a later read/edit fails, so the user can inspect the partial copy.
  await deps.store.set(`binding:resource:${resource.id}`, true);
  await deps.store.set(`recipe-output:${requestId}`, { resourceId: resource.id, providerId: outputId, recipeId: recipe.id, sourceId: source.id, destinationId: destination.id, url: resource.url });
  let plan = await deps.store.get<RecipeEditPlan>(`recipe-plan:${requestId}`);
  if (!plan) {
    try {
      const document = await deps.provider.getDocument(outputId);
      if (document.documentId !== outputId) throw new GoogleIntegrationError('RECIPE_OUTPUT_MISMATCH', 'Google returned a document different from the newly created copy.', 409);
      plan = planRecipeEdits(document, values);
      await deps.store.set(`recipe-plan:${requestId}`, plan);
    } catch (error) {
      return { entityId: resource.id, status: 'failed', writes, receipt, message: `The new copy exists at ${resource.url}, but personalization did not start. ${error instanceof GoogleIntegrationError ? error.message : 'Read its current state before retrying this same request.'}` };
    }
  }
  const edited = await deps.operation(`recipe-edit:${requestId}`, { ...inputs, outputId }, required, () => deps.provider.applyRecipeEdits(outputId, source.providerId!, plan!));
  if (edited.status !== 'accepted') return { entityId: resource.id, status: edited.status === 'failed' ? 'failed' : 'unknown', writes, receipt, message: `New copy: ${resource.url}. Personalization ${edited.status === 'failed' ? 'failed' : 'is unconfirmed'}; the reference was not edited. ${edited.error ?? 'Reconcile the new copy before retrying.'}` };
  if (!edited.replayed) writes++;
  const details = plan.appendedContext ? 'Added the supplied context section while preserving the reference text and native structure.' : `Replaced ${plan.replacements} supported template placeholder${plan.replacements === 1 ? '' : 's'} while retaining the native document structure.`;
  return { entityId: resource.id, status: 'succeeded', writes, receipt, message: `Created ${resource.url}. ${details} Deterministic personalization; no model calls.` };
}
