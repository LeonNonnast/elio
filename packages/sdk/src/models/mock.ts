// ───────────────────────────── MockModel: deterministischer ModelService (Slice 3, §6) ─────────────────────────────
// Default-Modell für Tests + Offline-Demo. KEIN Netz. Echo-/Transform-basiert: spiegelt die letzte
// user-Message, leitet Token-Counts aus der String-Länge ab und liefert eine feste Confidence.
// Vollständig deterministisch -> reproduzierbare Evals + Tests ohne Provider.

import type { Cost } from "@elio/core";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  ModelService,
} from "./types";
import { lastUserContent, normalizeRequest } from "./types";

export interface MockModelOptions {
  /** Modell-ID, die in Cost.model gemeldet wird (Default "mock"). */
  model?: string;
  /** Feste Confidence (Default 1). */
  confidence?: number;
  /**
   * Transformation der letzten user-Message zur Antwort. Default: prefixt "echo: ".
   * Deterministisch halten — sonst sind Tests/Evals nicht reproduzierbar.
   */
  transform?: (lastUser: string, req: CompletionRequest) => string;
  /** Tokens-pro-Zeichen-Heuristik (Default 1 Token / 4 Zeichen, mind. 1). */
  charsPerToken?: number;
}

/** ~Token-Count aus String-Länge (deterministisch). */
function estimateTokens(s: string, charsPerToken: number): number {
  if (s.length === 0) return 0;
  return Math.max(1, Math.ceil(s.length / charsPerToken));
}

export class MockModel implements ModelService {
  private readonly model: string;
  private readonly confidence: number;
  private readonly charsPerToken: number;
  private readonly transform: (lastUser: string, req: CompletionRequest) => string;

  constructor(opts: MockModelOptions = {}) {
    this.model = opts.model ?? "mock";
    this.confidence = opts.confidence ?? 1;
    this.charsPerToken = opts.charsPerToken ?? 4;
    this.transform = opts.transform ?? ((lastUser) => `echo: ${lastUser}`);
  }

  /** Baut Text + Cost deterministisch aus dem Request (geteilt von complete/stream). */
  private derive(req: CompletionRequest): { text: string; cost: Cost; confidence: number } {
    const lastUser = lastUserContent(req);
    const text = this.transform(lastUser, req);

    // Token-Counts aus den Längen ableiten: Input = system + alle messages, Output = Antwort.
    const inputStr = (req.system ?? "") + req.messages.map((m) => m.content).join("");
    const tokensIn = estimateTokens(inputStr, this.charsPerToken);
    const tokensOut = estimateTokens(text, this.charsPerToken);

    const cost: Cost = { usd: 0, tokensIn, tokensOut, model: this.model };
    return { text, cost, confidence: this.confidence };
  }

  complete(req: unknown): Promise<CompletionResult> {
    return Promise.resolve(this.derive(normalizeRequest(req)));
  }

  async *stream(req: unknown): AsyncIterable<CompletionChunk> {
    const { text, cost, confidence } = this.derive(normalizeRequest(req));
    // Wort-für-Wort streamen (deterministisch), dann der done-Marker mit Cost/Confidence.
    const parts = text.length > 0 ? text.split(/(?<=\s)/) : [];
    for (const p of parts) {
      yield { delta: p };
    }
    yield { done: { cost, confidence } };
  }
}
