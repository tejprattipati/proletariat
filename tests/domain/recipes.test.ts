import { describe, expect, it } from "vitest";
import { applyAction } from "../../src/lib/domain/actions";
import { personalizeRecipeText } from "../../src/lib/domain/recipes";
import { now, task, workspace } from "./helpers";

function prepared() {
  const state = workspace();
  state.resources.find(resource => resource.id === "demo-folder")!.bound = true;
  state.resources.find(resource => resource.id === "demo-project-notes")!.content = "# {{title}}\n\nFor {{person}}\n\n| Area | Detail |\n| ---- | ------ |\n| Context | {{context}} |\n\nKeep this closing paragraph.";
  state.permissions.driveWrite = true;
  state.permissions.docsWrite = true;
  state.tasks = [task("task-example", { agentId: "agent-work", sourceIds: ["demo-project-notes"], needsInput: "Review the completed draft." })];
  return applyAction(state, { type: "recipe.create", payload: { name: "Example brief", referenceResourceId: "demo-project-notes", destinationFolderId: "demo-folder", agentId: "agent-work" }, requestId: "recipe-create" }, now);
}

describe("reusable document recipes", () => {
  it("normalizes old state and creates/updates one reusable recipe without copying a document", () => {
    const state = workspace(); delete state.recipes;
    state.resources[0].bound = true;
    const before = structuredClone(state.resources);
    const created = applyAction(state, { type: "recipe.create", payload: { name: "Example recipe", referenceResourceId: "demo-project-notes", destinationFolderId: "demo-folder" } }, now);
    expect(created.state.recipes).toHaveLength(1);
    expect(created.state.resources).toEqual(before);
    const updated = applyAction(created.state, { type: "recipe.update", payload: { id: created.entityId, name: "Renamed", agentId: "agent-work" } }, new Date("2026-10-04T08:00:00Z"));
    expect(updated.state.recipes).toHaveLength(1);
    expect(updated.state.recipes![0]).toMatchObject({ id: created.entityId, name: "Renamed", agentId: "agent-work", createdAt: now.toISOString() });
    expect(updated.state.runs[0]).toMatchObject({ recipeId: created.entityId, sourceIds: ["demo-project-notes"], changedResourceIds: [], modelCalls: 0, apiCalls: 0 });
  });
  it("copies into the bound destination and preserves source structure while personalizing", () => {
    const created = prepared(); const source = structuredClone(created.state.resources.find(resource => resource.id === "demo-project-notes"));
    const before = structuredClone(created.state);
    const result = applyAction(created.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example launch brief", context: "A fictional launch", person: "Alex", taskId: "task-example" }, requestId: "run-one" }, now);
    const output = result.state.resources.find(resource => resource.id === result.entityId)!;
    expect(output).toMatchObject({ name: "Example launch brief (synthetic)", parentId: "demo-folder", role: "output", bound: true, mode: "demo", kind: "document" });
    expect(output.content).toBe("# Example launch brief\n\nFor Alex\n\n| Area | Detail |\n| ---- | ------ |\n| Context | A fictional launch |\n\nKeep this closing paragraph.");
    expect(result.state.resources.find(resource => resource.id === source!.id)).toEqual(source);
    expect(created.state).toEqual(before);
    expect(result.state.tasks[0]).toMatchObject({ id: "task-example", status: "open", needsInput: "Review the completed draft." });
    expect(result.state.runs[0]).toMatchObject({ taskId: "task-example", recipeId: created.entityId, agentId: "agent-work", sourceIds: ["demo-project-notes"], changedResourceIds: [output.id], changedEventIds: [], modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0 });
    expect(result.message).toMatch(/synthetic personalized/);
  });
  it("reuses configuration across distinct runs and never recopies a replayed request", () => {
    const created = prepared();
    const action = { type: "recipe.run", payload: { id: created.entityId, title: "Example one", context: "First context" }, requestId: "run-one" };
    const first = applyAction(created.state, action, now);
    const repeated = applyAction(first.state, action, new Date("2026-10-04T08:00:00Z"));
    expect(repeated).toEqual(first);
    const second = applyAction(first.state, { ...action, payload: { ...action.payload, title: "Example two", context: "Second context" }, requestId: "run-two" }, now);
    expect(second.state.recipes).toHaveLength(1);
    expect(second.state.resources).toHaveLength(created.state.resources.length + 2);
    expect(second.entityId).not.toBe(first.entityId);
  });
  it("appends explicit context when the template has no context placeholder", () => {
    const content = "# Existing structure\n\nFirst section\n\nSecond section\n";
    expect(personalizeRecipeText(content, { title: "Brief", context: "New fictional context", person: "Casey" })).toBe(`${content}\nContext\nNew fictional context\nPerson: Casey\n`);
  });
  it("substitutes literally once and preserves unsupported placeholders", () => {
    expect(personalizeRecipeText("{{title}} / {{person}} / {{context}} / {{unknown}}", { title: "{{context}}", context: "$&\n{{title}}" })).toBe("{{context}} /  / $&\n{{title}} / {{unknown}}");
  });
  it.each(["driveRead", "driveWrite", "docsWrite"] as const)("rechecks %s at execution after the recipe was saved", permission => {
    const created = prepared(); created.state.permissions[permission] = false;
    const before = structuredClone(created.state);
    expect(() => applyAction(created.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example", context: "Context" } }, now)).toThrow(permission);
    expect(created.state).toEqual(before);
  });
  it("rejects unbound/wrong-kind references and destinations before saving or running", () => {
    const created = prepared();
    expect(() => applyAction(created.state, { type: "recipe.update", payload: { id: created.entityId, referenceResourceId: "demo-recipient-sheet" } }, now)).toThrow(/bound document/);
    expect(() => applyAction(created.state, { type: "recipe.update", payload: { id: created.entityId, destinationFolderId: "demo-weekly-output" } }, now)).toThrow(/bound folder/);
    created.state.resources[0].bound = false;
    expect(() => applyAction(created.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example", context: "Context" } }, now)).toThrow(/bound folder/);
  });
  it("validates task identity and attributes reused recipes to the linked task's current agent", () => {
    const created = prepared();
    expect(() => applyAction(created.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example", context: "Context", taskId: "missing" } }, now)).toThrow(/Task was not found/);
    created.state.tasks[0].agentId = "agent-learning";
    const result = applyAction(created.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example", context: "Context", taskId: "task-example" } }, now);
    expect(result.state.runs[0]).toMatchObject({ taskId: "task-example", agentId: "agent-learning", recipeId: created.entityId });
    expect(result.state.recipes![0].agentId).toBe("agent-work");
  });
  it("requires actual loaded reference text and meaningful personalization context", () => {
    const created = prepared();
    expect(() => applyAction(created.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example", context: " " } }, now)).toThrow(/Context/);
    delete created.state.resources.find(resource => resource.id === "demo-project-notes")!.content;
    expect(() => applyAction(created.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example", context: "Context" } }, now)).toThrow(/loaded text/);
  });
  it("allows live recipe configuration but requires the adapter for live execution", () => {
    const created = prepared(); created.state.settings.mode = "live";
    for (const resource of created.state.resources) resource.mode = "live";
    const updated = applyAction(created.state, { type: "recipe.update", payload: { id: created.entityId, name: "Live recipe" } }, now);
    expect(updated.state.recipes![0].name).toBe("Live recipe");
    expect(() => applyAction(updated.state, { type: "recipe.run", payload: { id: created.entityId, title: "Example", context: "Context" } }, now)).toThrow(/adapter/);
  });
});
