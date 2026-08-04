import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MessageStore } from "../messaging/store.js";
import { SwarmOrchestrator } from "../orchestrator/swarm.js";
import { SwarmStore } from "../orchestrator/swarmStore.js";
import { TaskStore } from "../tasks/store.js";
import { CoordinationService } from "./service.js";

let home: string;
let tasks: TaskStore;
let messages: MessageStore;
let swarms: SwarmStore;
let coordination: CoordinationService;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-coordination-"));
  tasks = new TaskStore(home);
  messages = new MessageStore(home);
  swarms = new SwarmStore(home);
  coordination = new CoordinationService(tasks, messages, swarms);
});

afterEach(async () => {
  tasks.dispose();
  messages.dispose();
  swarms.dispose();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("CoordinationService", () => {
  test("links a persistent task to its assignment message", async () => {
    const task = await coordination.createTask({
      title: "Ship coordination",
      createdBy: "lead",
      assignee: "builder"
    });

    expect(task.messageIds).toHaveLength(1);
    expect(task.coordinationEvents[0].status).toBe("sent");
    const ms = new MessageStore(home);
    const linked = await ms.listForTask(task.id);
    ms.dispose();
    expect(linked).toHaveLength(1);
    expect(linked[0].subject).toContain("Task assigned");
  });

  test("recovery replays a pending notification exactly once", async () => {
    const task = await tasks.create({
      title: "Interrupted assignment",
      createdBy: "lead",
      assignee: "builder"
    });
    const [{ event }] = await tasks.pendingCoordinationEvents(task.id);

    // Simulate a crash after the message write but before the task outbox was
    // marked sent. Recovery must reuse this message, not append a duplicate.
    await messages.send({
      from: event.from,
      to: event.to,
      subject: event.subject,
      body: event.body,
      taskId: task.id,
      coordinationEventId: event.id
    });

    const ts1 = new TaskStore(home);
    const ms1 = new MessageStore(home);
    const first = await new CoordinationService(ts1, ms1).recover();
    ts1.dispose();
    ms1.dispose();

    const ts2 = new TaskStore(home);
    const ms2 = new MessageStore(home);
    const second = await new CoordinationService(ts2, ms2).recover();
    ts2.dispose();
    ms2.dispose();

    expect(first.messagesDelivered).toBe(1);
    expect(second.messagesDelivered).toBe(0);
    expect(await messages.listForTask(task.id)).toHaveLength(1);
  });

  test("recovers a legacy workflow into linked task, consensus, and messages", async () => {
    const orchestrator = new SwarmOrchestrator();
    const workflow = orchestrator.createSwarmWorkflow("Recover release", [
      { id: "architect-1", name: "Architect", role: "architect", capabilities: [] },
      { id: "coder-1", name: "Coder", role: "coder", capabilities: [] },
      { id: "reviewer-1", name: "Reviewer", role: "reviewer", capabilities: [] },
      { id: "qa-1", name: "QA", role: "qa", capabilities: [] }
    ]);
    orchestrator.initiateProposal(workflow, workflow.id, "coder-1", "Ship release");
    await swarms.save(workflow);

    const report = await coordination.recover();
    const recovered = await swarms.get(workflow.id);
    const task = await tasks.get(recovered!.primaryTaskId!);

    expect(report).toMatchObject({
      workflowsScanned: 1,
      workflowsRepaired: 1,
      tasksCreated: 1,
      proposalsReconciled: 1,
      messagesDelivered: 1
    });
    expect(recovered?.status).toBe("active");
    expect(task?.workflowId).toBe(workflow.id);
    expect(task?.proposals[0].taskId).toBe(task?.id);
    expect(recovered?.messageIds).toEqual(task?.messageIds);

    const ts1 = new TaskStore(home);
    const ms1 = new MessageStore(home);
    const ss1 = new SwarmStore(home);
    const firstVote = await new CoordinationService(ts1, ms1, ss1).voteOnSwarmProposal(
      task!.proposals[0].id, "reviewer-1", "approve", "review passed"
    );
    ts1.dispose();
    ms1.dispose();
    ss1.dispose();

    const ts2 = new TaskStore(home);
    const ms2 = new MessageStore(home);
    const ss2 = new SwarmStore(home);
    const secondVote = await new CoordinationService(ts2, ms2, ss2).voteOnSwarmProposal(
      task!.proposals[0].id, "qa-1", "approve", "tests passed"
    );
    ts2.dispose();
    ms2.dispose();
    ss2.dispose();

    expect(firstVote?.proposal.status).toBe("pending");
    expect(secondVote?.proposal.status).toBe("approved");
    expect(secondVote?.task.checklist[0].done).toBe(true);
    expect(await messages.listForTask(task!.id)).toHaveLength(2);
  });
});
