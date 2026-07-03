import { describe, expect, it } from "vitest";
import { BudgetTracker, TrackerCostService } from "./cost";

describe("BudgetTracker — USD budget", () => {
  it("charge() only counts cost.usd; tokens do not decrement remaining()", () => {
    const b = new BudgetTracker(10, 5);
    b.charge({ usd: 3 });
    expect(b.charged()).toBe(3);
    expect(b.remaining()).toBe(7);
    // token-only cost does NOT touch the USD budget (documented limitation -> iteration bound covers it)
    b.charge({ tokensIn: 1000, tokensOut: 1000 });
    expect(b.charged()).toBe(3);
  });

  it("isExhausted() once remaining() <= 0", () => {
    const b = new BudgetTracker(1, 5);
    expect(b.isExhausted()).toBe(false);
    b.charge({ usd: 1 });
    expect(b.isExhausted()).toBe(true);
  });
});

describe("BudgetTracker — hard USD cost cap (maxCostUsd, §v0.2)", () => {
  it("no cap by default — isOverCostCap() always false", () => {
    const b = new BudgetTracker(1e9, 100);
    b.charge({ usd: 500 });
    expect(b.maxCostUsd).toBeUndefined();
    expect(b.isOverCostCap()).toBe(false);
  });

  it("trips once charged() reaches maxCostUsd (>=)", () => {
    const b = new BudgetTracker(1e9, 100, 0, 0, 0, 5);
    expect(b.isOverCostCap()).toBe(false);
    b.charge({ usd: 4.99 });
    expect(b.isOverCostCap()).toBe(false);
    b.charge({ usd: 0.01 }); // total 5.00 == cap
    expect(b.isOverCostCap()).toBe(true);
  });

  it("token-only cost never trips the cap (needs real cost.usd)", () => {
    const b = new BudgetTracker(1e9, 100, 0, 0, 0, 1);
    b.charge({ tokensIn: 1e6, tokensOut: 1e6 });
    expect(b.isOverCostCap()).toBe(false);
  });

  it("child() and view() inherit the cap", () => {
    const b = new BudgetTracker(100, 100, 0, 0, 0, 7);
    expect(b.child().maxCostUsd).toBe(7);
    expect(b.view().maxCostUsd).toBe(7);
  });

  it("cap is constructor-seedable (resume carries it via RunInput)", () => {
    const b = new BudgetTracker(1e9, 100, 0, 4, 0, 5);
    expect(b.isOverCostCap()).toBe(false);
    b.charge({ usd: 1 }); // 4 (seeded) + 1 == cap
    expect(b.isOverCostCap()).toBe(true);
  });
});

describe("BudgetTracker — Outer-Loop iteration bound (Inv. 21, §4 4a)", () => {
  it("tickIteration() advances the iteration counter independent of cost", () => {
    const b = new BudgetTracker(1e9, 3);
    expect(b.iterationCount()).toBe(0);
    b.tickIteration();
    b.tickIteration();
    expect(b.iterationCount()).toBe(2);
  });

  it("isAtMaxDepth() fires once iterations reach maxDepth — even with zero cost charged", () => {
    const b = new BudgetTracker(1e9, 2, 0, 0);
    // budget never exhausts (huge), depth stays 0; the bound must come from iterations.
    expect(b.isAtMaxDepth()).toBe(false);
    b.tickIteration(); // 1
    expect(b.isAtMaxDepth()).toBe(false);
    b.tickIteration(); // 2 == maxDepth
    expect(b.isAtMaxDepth()).toBe(true);
  });

  it("maxDepth=0 is at-bound before any tick (stops immediately)", () => {
    const b = new BudgetTracker(1e9, 0);
    expect(b.isAtMaxDepth()).toBe(true);
  });

  it("a real recursion depth >= maxDepth also fires the bound", () => {
    const b = new BudgetTracker(1e9, 2, 2, 0);
    expect(b.isAtMaxDepth()).toBe(true);
  });

  it("iteration count is constructor-seedable (resume continues the bound)", () => {
    const b = new BudgetTracker(1e9, 5, 0, 0, 4);
    expect(b.iterationCount()).toBe(4);
    expect(b.isAtMaxDepth()).toBe(false);
    b.tickIteration();
    expect(b.isAtMaxDepth()).toBe(true);
  });
});

describe("TrackerCostService", () => {
  it("delegates charge/remaining to its tracker", () => {
    const tracker = new BudgetTracker(10, 5);
    const svc = new TrackerCostService(tracker);
    svc.charge({ usd: 4 });
    expect(svc.remaining()).toBe(6);
    expect(tracker.charged()).toBe(4);
  });
});
