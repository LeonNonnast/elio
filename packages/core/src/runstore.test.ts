import { describe, expect, it } from "vitest";
import { corrKey, InMemoryRunStore, newStepCheckpointId } from "@elio/core";
import type { Checkpoint, CorrelationId, RunEvent, TapeFrame } from "@elio/core";

function corr(over: Partial<CorrelationId> = {}): CorrelationId {
  return { run: "run_1", branch: "branch_1", step: "s1", checkpoint: "cp_1", ...over };
}

function frame(c: CorrelationId, nodeType: string): TapeFrame {
  return {
    correlation: c,
    nodeType,
    input: {},
    result: { status: "resolved", output: {}, confidence: 1, cost: {} },
    injected: ["policy"],
    ts: new Date().toISOString(),
  };
}

describe("InMemoryRunStore — checkpoints (keyed by corrKey)", () => {
  it("saves and loads a checkpoint by correlation id", async () => {
    const store = new InMemoryRunStore();
    const c = corr({ checkpoint: newStepCheckpointId() });
    const cp: Checkpoint = {
      id: c.checkpoint,
      correlation: c,
      state: { x: 1 },
      artifactRef: { id: "a1", version: 0, kind: "k" },
      packVersion: "hash123",
      createdAt: new Date().toISOString(),
    };
    await store.saveCheckpoint(cp);
    const loaded = await store.loadCheckpoint(c);
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toEqual({ x: 1 });
    expect(corrKey(loaded!.correlation)).toBe(corrKey(c));
  });

  it("returns null for an unknown correlation id", async () => {
    const store = new InMemoryRunStore();
    expect(await store.loadCheckpoint(corr({ checkpoint: "missing" }))).toBeNull();
  });

  it("records an elicitation answer addressable by correlation id", async () => {
    const store = new InMemoryRunStore();
    const c = corr();
    await store.resolveElicitation(c, { approved: true });
    expect(store.getAnswer(c)?.answer).toEqual({ approved: true });
  });
});

describe("InMemoryRunStore — loop tape (append + read)", () => {
  it("appends and reads tape frames via async iterable and sync getTape", async () => {
    const store = new InMemoryRunStore();
    const run = (await store.createRun({ payload: {}, budget: 1, maxDepth: 4 })).id;
    await store.appendTape(run, frame(corr({ run }), "read_source"));
    await store.appendTape(run, frame(corr({ run, step: "s2" }), "transform"));

    const collected: string[] = [];
    for await (const f of store.tape(run)) collected.push(f.nodeType);
    expect(collected).toEqual(["read_source", "transform"]);
    expect(store.getTape(run).map((f) => f.nodeType)).toEqual(["read_source", "transform"]);
  });
});

describe("InMemoryRunStore — live subscribe (buffer + waiters)", () => {
  it("delivers buffered events and then awaits new ones", async () => {
    const store = new InMemoryRunStore();
    const ev: RunEvent = { type: "run-started", correlation: corr(), feature: "demo" };

    // buffered-before-consume path
    store.publish(ev);
    const it1 = store.subscribe()[Symbol.asyncIterator]();
    // a subscriber created AFTER publish should not see the earlier event (it joined late)
    // so publish again to exercise the waiter path:
    const pending = it1.next();
    const ev2: RunEvent = { type: "step-started", correlation: corr(), nodeType: "transform" };
    store.publish(ev2);
    const got = await pending;
    expect(got.done).toBe(false);
    expect(got.value.type).toBe("step-started");
  });

  it("filters by run id", async () => {
    const store = new InMemoryRunStore();
    const it = store.subscribe({ run: "run_X" })[Symbol.asyncIterator]();
    const pending = it.next();
    store.publish({ type: "run-started", correlation: corr({ run: "run_other" }), feature: "f" });
    store.publish({ type: "run-started", correlation: corr({ run: "run_X" }), feature: "f" });
    const got = await pending;
    expect(got.value.correlation.run).toBe("run_X");
  });

  it("unregisters the channel when a consumer breaks out of the loop early (no leak)", async () => {
    const store = new InMemoryRunStore();
    expect(store.subscriberCount()).toBe(0);

    // consume the first event then break — for-await calls iterator.return() on break.
    const consumed: RunEvent[] = [];
    const loop = (async () => {
      for await (const ev of store.subscribe()) {
        consumed.push(ev);
        break; // early exit -> return() must clean up the channel
      }
    })();
    // give the loop a tick to register + start awaiting, then publish one event
    await Promise.resolve();
    store.publish({ type: "run-started", correlation: corr(), feature: "f" });
    await loop;

    expect(consumed).toHaveLength(1);
    // the abandoned channel was removed; publish() will not grow an orphaned buffer forever.
    expect(store.subscriberCount()).toBe(0);
  });

  it("explicit iterator.return() removes the channel", async () => {
    const store = new InMemoryRunStore();
    const it = store.subscribe()[Symbol.asyncIterator]();
    const pending = it.next();
    expect(store.subscriberCount()).toBe(1);
    await it.return?.();
    const done = await pending;
    expect(done.done).toBe(true);
    expect(store.subscriberCount()).toBe(0);
  });
});

describe("InMemoryRunStore — liveStatus snapshot", () => {
  it("reflects set statuses", async () => {
    const store = new InMemoryRunStore();
    store.setStatus({
      correlation: corr(),
      feature: "demo",
      phase: "running",
      cost: {},
    });
    const statuses = await store.liveStatus();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.phase).toBe("running");
  });
});
