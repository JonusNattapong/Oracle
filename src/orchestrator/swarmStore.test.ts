import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SwarmOrchestrator } from "./swarm.js";
import { SwarmStore } from "./swarmStore.js";

let home: string;
let store: SwarmStore;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-swarms-"));
  store = new SwarmStore(home);
});

afterEach(async () => {
  store.dispose();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("SwarmStore", () => {
  test("persists workflows and proposals across store instances", async () => {
    const orchestrator = new SwarmOrchestrator();
    const workflow = orchestrator.createSwarmWorkflow("Ship feature", [
      { id: "architect-1", name: "Architect", role: "architect", capabilities: [] },
      { id: "coder-1", name: "Coder", role: "coder", capabilities: [] },
      { id: "reviewer-1", name: "Reviewer", role: "reviewer", capabilities: [] },
      { id: "qa-1", name: "QA", role: "qa", capabilities: [] }
    ]);
    const proposal = orchestrator.initiateProposal(
      workflow,
      "task-1",
      "coder-1",
      "Implement the feature"
    );
    await store.save(workflow);

    const store2 = new SwarmStore(home);
    const reloaded = await store2.get(workflow.id);
    store2.dispose();
    expect(reloaded?.title).toBe("Ship feature");
    expect(reloaded?.proposals).toHaveLength(1);
    expect(reloaded?.proposals[0].id).toBe(proposal.id);
  });

  test("findProposal returns its owning workflow", async () => {
    const orchestrator = new SwarmOrchestrator();
    const workflow = orchestrator.createSwarmWorkflow("Review release", []);
    const proposal = orchestrator.initiateProposal(workflow, "task-2", "architect-1", "Release v1");
    await store.save(workflow);

    const found = await store.findProposal(proposal.id);
    expect(found?.workflow.id).toBe(workflow.id);
    expect(found?.proposal.proposedAction).toBe("Release v1");
  });

  test("imports a legacy JSON workflow without deleting it", async () => {
    const orchestrator = new SwarmOrchestrator();
    const workflow = orchestrator.createSwarmWorkflow("Legacy workflow", []);
    const directory = path.join(home, "swarms");
    const filePath = path.join(directory, `${workflow.id}.json`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(workflow), "utf8");

    store.dispose();
    store = new SwarmStore(home);
    expect(await store.get(workflow.id)).toMatchObject({
      id: workflow.id,
      title: "Legacy workflow"
    });
    await expect(fs.stat(filePath)).resolves.toBeDefined();
  });
});
