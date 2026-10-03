import type { Recipe, Resource, WorkspaceState } from "../types";
import { assert, text } from "./core";
import { requirePermission } from "./workflows";

export function validateRecipe(state: WorkspaceState, recipe: Recipe): { reference: Resource; destination: Resource } {
  text(recipe.name, "Recipe name");
  const reference = state.resources.find(resource => resource.id === recipe.referenceResourceId);
  const destination = state.resources.find(resource => resource.id === recipe.destinationFolderId);
  assert(reference?.bound && reference.kind === "document", "The recipe reference must be a bound document.");
  assert(destination?.bound && destination.kind === "folder", "The recipe destination must be a bound folder.");
  assert(reference.mode === state.settings.mode && destination.mode === state.settings.mode, "Recipe resources must belong to the current workspace mode.");
  if (recipe.agentId) assert(state.agents.some(agent => agent.id === recipe.agentId), "Recipe agent was not found.", "NOT_FOUND");
  return { reference, destination };
}

/** Substitution is literal, single-pass, and preserves every other byte of the reference. */
export function personalizeRecipeText(reference: string, fields: { title: string; context: string; person?: string }): string {
  const title = text(fields.title, "Document title"), context = text(fields.context, "Context");
  assert(typeof reference === "string", "Reference content must be text.");
  assert(fields.person === undefined || typeof fields.person === "string", "Person must be text.");
  const replacements = { title, context, person: fields.person?.trim() ?? "" };
  const includesContext = reference.includes("{{context}}");
  const personalized = reference.replace(/\{\{(title|context|person)\}\}/g, (_, key: keyof typeof replacements) => replacements[key]);
  return includesContext ? personalized : `${personalized}${personalized.endsWith("\n") ? "\n" : "\n\n"}Context\n${context}${fields.person?.trim() ? `\nPerson: ${fields.person.trim()}` : ""}\n`;
}

export function runDemoRecipe(state: WorkspaceState, recipe: Recipe, outputId: string, fields: { title: string; context: string; person?: string; taskId?: string }, now: Date): Resource {
  assert(state.settings.mode === "demo", "Live document recipes require the Google adapter.", "LIVE_ADAPTER_REQUIRED");
  requirePermission(state.permissions, "driveRead", "driveWrite", "docsWrite");
  const { reference, destination } = validateRecipe(state, recipe);
  if (fields.taskId) {
    const task = state.tasks.find(item => item.id === fields.taskId);
    assert(task, "Task was not found.", "NOT_FOUND");
  }
  assert(typeof reference.content === "string", "The synthetic reference has no loaded text to personalize.");
  const title = text(fields.title, "Document title");
  return {
    id: outputId, name: `${title} (synthetic)`, kind: "document", parentId: destination.id,
    url: `https://example.com/resources/${encodeURIComponent(outputId)}`, role: "output", bound: true,
    modifiedAt: now.toISOString(), mode: "demo", content: personalizeRecipeText(reference.content, fields),
  };
}
