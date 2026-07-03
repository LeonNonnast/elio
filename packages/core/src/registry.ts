// ───────────────────────────── Node-Registry: built-in == custom (Inv. 6) ─────────────────────────────
// Es gibt keine privilegierte Step-Klasse; ein Custom-Handler ist genauso eine Node wie `validate`.

import type { NodeDefinition } from "./node";

export class NodeRegistry {
  private readonly defs = new Map<string, NodeDefinition>();

  /** Registriert eine Node-Definition unter ihrem `type`. Überschreibt einen vorhandenen Typ. */
  register(def: NodeDefinition): void {
    this.defs.set(def.type, def);
  }

  /** Löst eine Node-Definition auf; wirft, wenn der Typ nicht registriert ist (§4 Schritt 6). */
  resolve(type: string): NodeDefinition {
    const def = this.defs.get(type);
    if (def === undefined) {
      throw new Error(
        `NodeRegistry: kein Node-Typ "${type}" registriert. Bekannt: [${this.list().join(", ")}]`,
      );
    }
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  /** Alle registrierten Typen (z.B. Step-Whitelist / Diagnose). */
  list(): string[] {
    return [...this.defs.keys()];
  }
}
