// ───────────────────────────── Budget + Tiefe: Pflicht, propagiert/dekrementiert (Inv. 21, §11/#3) ─────────────────────────────
// budget & maxDepth sind verpflichtend und werden über JEDE Grenze dekrementiert; ein
// verschachtelter Call erbt das Restbudget, nie ein frisches. Erschöpfung -> Elicitation
// (entscheidet der Runner), kein hartes Sterben.

import type { Cost } from "./common";
import type { CostService } from "./ctx";

/**
 * Verfolgt verbrauchtes Budget (USD), die aktuelle Rekursionstiefe und — als IMMER wirksamer
 * Outer-Loop-Bound (Inv. 21) — die Anzahl bereits gelaufener Outer-Loop-Iterationen.
 *
 * `remaining()` = initialBudget - Summe geladener Kosten. `charge()` zieht ab.
 * `depth` = aktuelle Tiefe; `childDepth()` = Tiefe für einen verschachtelten Call.
 *
 * **Warum ein Iterations-Bound zusätzlich zum USD-Budget (Inv. 21, §4 Schritt 4a):**
 * Der `Cost.usd`-basierte Budget-Stopp greift nur, wenn Nodes USD-Kosten melden. Die meisten
 * Orchestration-Nodes (transform/validate/Gate) sind aber legitim *zero-cost* (`cost:{}` oder
 * `usd:0`); ein LLM-Node in Slice 3 kann nur Token (`tokensIn/Out`) ohne `usd` melden. Damit der
 * Outer Loop trotzdem garantiert terminiert (Inv. 21: "kein Infinite-Loop"), wird pro
 * Outer-Iteration `tickIteration()` aufgerufen und gegen `maxDepth` geprüft — unabhängig von
 * `cost.usd`. So ist `maxDepth` in Slice 1 ein echter, immer wirksamer Loop-Bound (statt einer
 * still ignorierten No-op, solange Rekursions-Nesting noch nicht greift). Der HARD_CAP im Runner
 * bleibt nur das letzte Sicherheitsnetz, nicht der primäre Bound.
 */
export class BudgetTracker {
  readonly initialBudget: number;
  readonly maxDepth: number;
  readonly depth: number;
  /**
   * Harter USD-Ausgaben-Deckel für den GESAMTEN Run (optional, §v0.2). Anders als `initialBudget`
   * (Inv. 21: Erschöpfung eskaliert als Elicitation an den Menschen — "mehr freigeben?") ist dies
   * eine harte Geld-Grenze: wird sie überschritten, STOPPT der Lauf (kein Grant-Dialog). `undefined`
   * = kein Deckel (Default; rückwärtskompatibel). Greift nur, wenn Nodes echte `cost.usd` melden
   * (Provider-Profil mit `usdPerMTok`); reine Token-Kosten triggern ihn nicht — der Iterations-Bound
   * (`maxDepth`) bleibt das Backstop, genau wie beim Budget.
   */
  readonly maxCostUsd: number | undefined;
  private spent: number;
  private iterations: number;

  constructor(
    initialBudget: number,
    maxDepth: number,
    depth = 0,
    spent = 0,
    iterations = 0,
    maxCostUsd?: number,
  ) {
    this.initialBudget = initialBudget;
    this.maxDepth = maxDepth;
    this.depth = depth;
    this.spent = spent;
    this.iterations = iterations;
    this.maxCostUsd = maxCostUsd;
  }

  /** Verbleibendes Budget (kann negativ werden, wenn ein Call überzieht — Runner prüft). */
  remaining(): number {
    return this.initialBudget - this.spent;
  }

  /** Bisher verbraucht. */
  charged(): number {
    return this.spent;
  }

  /** Zieht die USD-Kosten eines NodeResults ab (tokens werden hier nicht in USD umgerechnet). */
  charge(cost: Cost): void {
    if (typeof cost.usd === "number") {
      this.spent += cost.usd;
    }
  }

  /** Budget erschöpft? */
  isExhausted(): boolean {
    return this.remaining() <= 0;
  }

  /**
   * Harter USD-Deckel überschritten? Nur wirksam, wenn `maxCostUsd` gesetzt ist. Vergleicht die
   * kumulativ verbuchten `cost.usd` (`charged()`) gegen den Deckel — der Runner stoppt den Lauf
   * hart (kein Elicitation-Grant, anders als bei `isExhausted()`).
   */
  isOverCostCap(): boolean {
    return this.maxCostUsd !== undefined && this.spent >= this.maxCostUsd;
  }

  /** Bisher gelaufene Outer-Loop-Iterationen. */
  iterationCount(): number {
    return this.iterations;
  }

  /**
   * Registriert eine Outer-Loop-Iteration. Wird einmal pro resolved Step gerufen (der Runner
   * ist die autoritative Senke). Bound-unabhängig von `cost.usd` (siehe Klassen-Doc).
   */
  tickIteration(): void {
    this.iterations += 1;
  }

  /**
   * Loop-Bound erreicht? In Slice 1 bindet `maxDepth` die Anzahl der Outer-Loop-Iterationen
   * (Rekursions-Nesting, das `depth` erhöht, ist v0.1 aufgeschoben — §7). Damit ist ein
   * gesetzter `maxDepth` immer wirksam: `maxDepth=0` stoppt vor dem ersten Step, `maxDepth=N`
   * erlaubt höchstens N resolved Outer-Iterationen. Bleibt korrekt, sobald `depth` real wächst:
   * sowohl Tiefen- als auch Iterations-Überschreitung stoppen den Loop.
   */
  isAtMaxDepth(): boolean {
    return this.depth >= this.maxDepth || this.iterations >= this.maxDepth;
  }

  /** Tiefe für einen verschachtelten Call (Inv. 21). */
  childDepth(): number {
    return this.depth + 1;
  }

  /**
   * Abgeleiteter Tracker für einen verschachtelten Call: erbt das RESTbudget (nie frisch, Inv. 21)
   * und läuft auf childDepth(). Verbrauch im Kind reduziert dessen eigenes remaining(); der Parent
   * wird beim Verbuchen des Kind-Cost via charge() dekrementiert.
   */
  child(): BudgetTracker {
    return new BudgetTracker(this.remaining(), this.maxDepth, this.childDepth(), 0, 0, this.maxCostUsd);
  }

  /**
   * Node-lokale SICHT auf diesen Tracker (Inv. 3/21): erbt das aktuelle RESTbudget + die GLEICHE Tiefe
   * (kein childDepth — eine gewöhnliche Outer-Loop-Node bleibt auf derselben Ebene; nur der agent-Node
   * steigt selbst eine Stufe tiefer). Schreibt ISOLIERT: `charge()` auf der Sicht mutiert NICHT diesen
   * (Run-)Tracker. So bleibt der Runner die EINZIGE autoritative Senke (er bucht den zurückgegebenen
   * Resolved.cost einmal), während eine Node trotzdem ein korrektes remaining()/depth()/maxDepth() liest
   * und node-lokal (transparent) mitbuchen kann, ohne doppelt zu dekrementieren.
   */
  view(): BudgetTracker {
    return new BudgetTracker(this.remaining(), this.maxDepth, this.depth, 0, 0, this.maxCostUsd);
  }
}

/**
 * CostService-Impl, gebunden an einen BudgetTracker. `ctx.cost` wird so gescopt, dass
 * eine Node nur gegen ihr (Rest-)Budget bucht (Inv. 3).
 */
export class TrackerCostService implements CostService {
  constructor(private readonly tracker: BudgetTracker) {}

  charge(c: Cost): void {
    this.tracker.charge(c);
  }

  remaining(): number {
    return this.tracker.remaining();
  }

  /** Aktuelle Tiefe dieses Scopes (Inv. 21) — speist die SessionContract.depth eines delegierten Calls. */
  depth(): number {
    return this.tracker.depth;
  }

  /** Rekursions-Ceiling (Inv. 21) — speist die SessionContract.maxDepth eines delegierten Calls. */
  maxDepth(): number {
    return this.tracker.maxDepth;
  }
}
