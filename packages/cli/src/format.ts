// ───────────────────────────── RunEvent / RunStatus -> menschenlesbare Zeilen ─────────────────────────────
// Reine Darstellungs-Helfer (keine Engine-Logik, Inv. 2): mappen die @elio/core-Events/Status auf
// kompakte CLI-Zeilen. Die correlation-id wird auf ein kurzes `branch@step`-Tag verdichtet, damit der
// Stream lesbar bleibt; `elio runs` zeigt die volle correlation-id für den Resume-Pfad.

import type { CorrelationId, Cost, Elicitation, RunEvent, RunStatus } from "@elio/core";

/** Verdichtet eine correlation-id auf ein kurzes, lesbares Tag (run.branch.step.checkpoint). */
export function corrTag(c: CorrelationId): string {
  return `${c.run}/${c.branch}/${c.step}#${c.checkpoint}`;
}

/** Kurze Cost-Darstellung (nur die gesetzten Felder). */
export function formatCost(cost: Cost | undefined): string {
  if (cost === undefined) return "";
  const parts: string[] = [];
  if (cost.usd !== undefined) parts.push(`$${cost.usd}`);
  if (cost.tokensIn !== undefined) parts.push(`in=${cost.tokensIn}`);
  if (cost.tokensOut !== undefined) parts.push(`out=${cost.tokensOut}`);
  if (cost.model !== undefined) parts.push(cost.model);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Eine kompakte, menschenlesbare Zeile für ein RunEvent. */
export function formatEvent(ev: RunEvent): string {
  const tag = corrTag(ev.correlation);
  switch (ev.type) {
    case "run-started":
      return `▶ run-started     ${tag}  feature=${ev.feature}`;
    case "step-started":
      return `· step-started    ${tag}  node=${ev.nodeType}`;
    case "node-resolved":
      return `✓ node-resolved   ${tag}${
        ev.confidence !== undefined ? `  confidence=${ev.confidence}` : ""
      }${formatCost(ev.cost)}`;
    case "node-suspended":
      return `⏸ node-suspended  ${tag}  mode=${ev.mode}  what="${ev.elicitation.what}"`;
    case "elicitation-resolved":
      return `↩ elicitation-resolved ${tag}  by=${ev.by}`;
    case "artifact-updated":
      return `△ artifact-updated ${tag}  artifact=${ev.artifact.kind}#${ev.artifact.id}@v${ev.artifact.version}`;
    case "cost-delta":
      return `$ cost-delta      ${tag}  delta=${formatCost(ev.delta).trim()}  total=${formatCost(
        ev.total,
      ).trim()}`;
    case "run-completed":
      return `■ run-completed   ${tag}  gate=${ev.gate}`;
    default: {
      // Erschöpfender Switch: jede neue RunEvent-Variante zwingt hier eine Ergänzung.
      const _exhaustive: never = ev;
      return JSON.stringify(_exhaustive);
    }
  }
}

/** Renderzeile für die Approval-Inbox-Aufforderung (an einer node-suspended Elicitation). */
export function formatElicitationPrompt(e: Elicitation): string {
  const who = formatAnswerer(e);
  const schema = e.schema !== undefined ? `\n  schema: ${JSON.stringify(e.schema)}` : "";
  const def = e.default !== undefined ? `\n  default: ${JSON.stringify(e.default)}` : "";
  return `\nAPPROVAL REQUIRED (${e.mode})\n  what: ${e.what}\n  who-can-answer: ${who}${schema}${def}`;
}

function formatAnswerer(e: Elicitation): string {
  const a = e.whoCanAnswer;
  const parts: string[] = [];
  if (a.roles && a.roles.length > 0) parts.push(`roles=[${a.roles.join(",")}]`);
  if (a.users && a.users.length > 0) parts.push(`users=[${a.users.join(",")}]`);
  if (a.machine === true) parts.push("machine");
  return parts.length > 0 ? parts.join(" ") : "operator";
}

/** Eine Zeile pro Run/Branch für `elio runs` (id, feature, phase, waitingOn). */
export function formatRunStatus(s: RunStatus): string {
  const tag = corrTag(s.correlation);
  const step = s.step !== undefined ? `  step=${s.step}` : "";
  const waiting =
    s.phase === "suspended" && s.waitingOn !== undefined
      ? `  waitingOn="${s.waitingOn.what}" (${s.waitingOn.mode})`
      : "";
  return `${tag}  feature=${s.feature}  phase=${s.phase}${step}${waiting}${formatCost(s.cost)}`;
}
