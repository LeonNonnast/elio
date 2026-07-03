// ───────────────────────────── LlmWorker: concurrency-gated Dispatcher (Slice 3, Inv. 17, §6) ─────────────────────────────
// ctx.model zeigt IMMER auf den Worker, NIE direkt auf einen Adapter. Der Worker routet req.model
// auf den passenden Provider (exakte Modell-ID ODER längstes Präfix-Match) und gated jeden Provider
// über ein Semaphor: pro Provider laufen nie mehr als `limit` Calls gleichzeitig; überzählige Calls
// warten in einer FIFO-Queue. Selbst gebaut (p-limit-artig) — KEINE neue Runtime-Dep.

import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  Cost,
  ModelService,
} from "./types";
import { normalizeRequest } from "./types";

/** Provider-Map: Modell-ID ODER Präfix -> ModelService. Beispiel: {"mock": ..., "claude": ...}. */
export type ProviderMap = Record<string, ModelService>;

export interface LlmWorkerOptions {
  /** Modell-/Präfix -> Adapter. */
  providers: ProviderMap;
  /** Default-Modell, falls req.model fehlt (z.B. "mock"). */
  defaultModel: string;
  /** Max. gleichzeitige Calls PRO Provider (Default 4). */
  concurrency?: number;
  /**
   * Grobe Kosten-Richtwerte je Profil-Key ($/MTok in/out). Ist für den (Profil-)Präfix einer kanonischen
   * Spec ein Eintrag gesetzt, stempelt der Worker cost.usd aus den zurückgegebenen Token-Counts —
   * zentral + profil-getrieben (statt einer präzisen Pricing-Tabelle pro Adapter, §6/Richtwerte).
   */
  costs?: Record<string, { in: number; out: number }>;
}

// ───────────────────────────── Semaphor (FIFO, pro Provider) ─────────────────────────────
/** Einfacher zählender Semaphor: acquire() wartet, bis ein Slot frei ist; release() gibt einen frei. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }

  /** Führt fn unter dem Limit aus (acquire -> fn -> release, auch im Fehlerfall). */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class LlmWorker implements ModelService {
  private readonly providers: ProviderMap;
  private readonly defaultModel: string;
  private readonly limit: number;
  private readonly costs: Record<string, { in: number; out: number }>;
  /** Ein Semaphor pro Provider-Key (lazy angelegt). */
  private readonly gates = new Map<string, Semaphore>();

  constructor(opts: LlmWorkerOptions) {
    this.providers = opts.providers;
    this.defaultModel = opts.defaultModel;
    this.limit = opts.concurrency ?? 4;
    this.costs = opts.costs ?? {};
  }

  private has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.providers, key);
  }

  /**
   * Wählt den Provider-Key für eine Modell-ID: exaktes Match gewinnt, sonst das LÄNGSTE Präfix,
   * das `model` als `${key}` oder `${key}/`/`${key}-`/`${key}:` beginnt. Kein Treffer -> Fehler.
   */
  private resolveKey(model: string): string {
    if (this.has(model)) return model;
    let best: string | undefined;
    for (const key of Object.keys(this.providers)) {
      if (
        model === key ||
        model.startsWith(`${key}/`) ||
        model.startsWith(`${key}-`) ||
        model.startsWith(`${key}:`)
      ) {
        if (best === undefined || key.length > best.length) best = key;
      }
    }
    if (best === undefined) {
      throw new Error(`LlmWorker: no provider registered for model "${model}"`);
    }
    return best;
  }

  /**
   * Löst eine (kanonische) Modell-Spec in (Provider-Key, reiner Modellname) auf. Die kanonische Form ist
   * `provider:model` (z.B. `ollama:llama3`, `azure-openai:gpt-4o`); der Step pinnt das per `with.provider`
   * + `with.model` (für Reproduzierbarkeit), die Node baut daraus diesen String.
   *  1. `provider:model` (erster Doppelpunkt, Präfix IST ein registrierter Provider) -> dorthin routen,
   *     den REST als reinen Modellnamen an den Adapter geben (so sieht Ollama `llama3` / `llama3:8b`, nicht
   *     `ollama:llama3`). Kein Rest -> Adapter-Default.
   *  2. exakter Provider-Key (z.B. `mock`) -> dorthin, Adapter nutzt sein Default-Modell.
   *  3. Legacy: längstes Präfix-Match (`claude-opus-4-8` -> Provider `claude`), Modell unverändert
   *     durchreichen (rückwärtskompatibel).
   */
  private resolveSpec(spec: string): { key: string; bareModel: string | undefined } {
    const ci = spec.indexOf(":");
    if (ci > 0) {
      const prefix = spec.slice(0, ci);
      if (this.has(prefix)) {
        const rest = spec.slice(ci + 1);
        return { key: prefix, bareModel: rest.length > 0 ? rest : undefined };
      }
    }
    if (this.has(spec)) return { key: spec, bareModel: undefined };
    return { key: this.resolveKey(spec), bareModel: spec };
  }

  private gate(key: string): Semaphore {
    let g = this.gates.get(key);
    if (g === undefined) {
      g = new Semaphore(this.limit);
      this.gates.set(key, g);
    }
    return g;
  }

  /** Löst (key, provider, normalisierten req, kanonische Spec) für einen rohen Request auf. */
  private route(reqRaw: unknown): {
    key: string;
    provider: ModelService;
    req: CompletionRequest;
    canonical: string;
  } {
    const req = normalizeRequest(reqRaw);
    const canonical = req.model ?? this.defaultModel;
    const { key, bareModel } = this.resolveSpec(canonical);
    const provider = this.providers[key];
    if (provider === undefined) {
      throw new Error(`LlmWorker: provider for key "${key}" missing`);
    }
    // Dem Adapter NUR den reinen Modellnamen geben (bareModel); ist er undefined, nutzt der Adapter sein
    // eigenes Default-Modell. `model` weglassen statt auf undefined zu setzen (exactOptionalPropertyTypes).
    const routed: CompletionRequest =
      bareModel !== undefined ? { ...req, model: bareModel } : { ...req };
    if (bareModel === undefined) delete routed.model;
    return { key, provider, req: routed, canonical };
  }

  /**
   * Stempelt cost.model auf die kanonische `provider:model`-Spec (Audit/Tape) und — falls ein grober
   * Kosten-Richtwert für den Profil-Präfix konfiguriert ist — cost.usd aus den Token-Counts. So liegt die
   * Geld-Schätzung zentral beim Worker (profil-getrieben), nicht in einer Pricing-Tabelle pro Adapter.
   */
  private stampCost(cost: Cost, canonical: string): Cost {
    let out = cost;
    if (canonical.includes(":")) out = { ...out, model: canonical };
    const prefix = canonical.includes(":") ? canonical.slice(0, canonical.indexOf(":")) : canonical;
    const rate = this.costs[prefix];
    if (rate !== undefined) {
      const tin = out.tokensIn ?? 0;
      const tout = out.tokensOut ?? 0;
      out = { ...out, usd: (tin / 1_000_000) * rate.in + (tout / 1_000_000) * rate.out };
    }
    return out;
  }

  async complete(reqRaw: unknown): Promise<CompletionResult> {
    // `async` macht Routing-Fehler zu einer rejected Promise (statt eines synchronen throw),
    // damit Caller sie einheitlich per await/catch behandeln.
    const { key, provider, req, canonical } = this.route(reqRaw);
    const result = await this.gate(key).run(() => provider.complete(req));
    return { ...result, cost: this.stampCost(result.cost, canonical) };
  }

  /**
   * Streaming durch das Semaphor: der Slot wird beim ersten Konsumieren des Iterators belegt und erst
   * freigegeben, wenn der Iterator erschöpft/abgebrochen ist — so zählt ein laufender Stream als
   * "in flight" gegen das Provider-Limit, genau wie ein complete()-Call.
   */
  async *stream(reqRaw: unknown): AsyncIterable<CompletionChunk> {
    const { key, provider, req, canonical } = this.route(reqRaw);
    if (provider.stream === undefined) {
      throw new Error(`LlmWorker: provider for key "${key}" does not support stream()`);
    }
    const gate = this.gate(key);
    await gate.acquire();
    try {
      // done-Chunk konsistent zu complete() stempeln (cost.model kanonisch + ggf. cost.usd aus Richtwert).
      for await (const chunk of provider.stream(req)) {
        if ("done" in chunk) {
          yield { done: { ...chunk.done, cost: this.stampCost(chunk.done.cost, canonical) } };
        } else {
          yield chunk;
        }
      }
    } finally {
      gate.release();
    }
  }
}
