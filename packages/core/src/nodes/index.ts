// ───────────────────────────── Built-in Nodes: Registrierung (Inv. 6 — built-in == custom) ─────────────────────────────
// registerBuiltins(registry) hängt die Built-ins an eine NodeRegistry (Slice 1: transform, validate;
// Slice 2: approval, subworkflow; Slice 3: llm, agent; Slice 4: router, condition, file, db, batch).
// Es gibt keine privilegierte Step-Klasse: diese Built-ins werden exakt wie Custom-Nodes registriert.

import type { NodeDefinition } from "../node";
import type { NodeRegistry } from "../registry";
import { transformNode } from "./transform";
import { validateNode } from "./validate";
import { approvalNode } from "./approval";
import { subworkflowNode } from "./subworkflow";
import { llmNode } from "./llm";
import { agentNode } from "./agent";
import { routerNode } from "./router";
import { conditionNode } from "./condition";
import { fileNode } from "./file";
import { dbNode } from "./db";
import { httpNode } from "./http";
import { batchNode } from "./batch";
import { retroMinerNode, retroCompleteNode } from "./retro";
import { memoLookupNode } from "./memo";
import { scriptEvalNode } from "./script-eval";
import { synthesizeScriptNode, synthesizeCompleteNode } from "./synthesize";
import { promoteApplyNode, promoteCompleteNode, demoteApplyNode, demoteCompleteNode } from "./promote";
import { featureRefNode } from "./feature-ref";

export { transformNode, transformHandler } from "./transform";
export type { TransformWith } from "./transform";
export { validateNode, validateHandler } from "./validate";
export type { ValidateWith, MiniSchema } from "./validate";
export { approvalNode, approvalHandler } from "./approval";
export type { ApprovalWith } from "./approval";
export { subworkflowNode, subworkflowHandler } from "./subworkflow";
export type { SubworkflowWith } from "./subworkflow";
export { llmNode, llmHandler, canonicalModel } from "./llm";
export type { LlmWith } from "./llm";
export { agentNode, agentHandler } from "./agent";
export type { AgentWith } from "./agent";
export { routerNode, routerHandler } from "./router";
export type { RouterWith } from "./router";
export { conditionNode, conditionHandler } from "./condition";
export type { ConditionWith } from "./condition";
export { fileNode, fileHandler } from "./file";
export type { FileWith } from "./file";
export { dbNode, dbHandler } from "./db";
export { httpNode, httpHandler } from "./http";
export type { DbWith } from "./db";
export { batchNode, batchHandler } from "./batch";
export type { BatchWith } from "./batch";
export { retroMinerNode, retroMinerHandler, retroCompleteNode, retroCompleteHandler } from "./retro";
export type { RetroMinerWith, RetroMinerName } from "./retro";
export { memoLookupNode, memoLookupHandler } from "./memo";
export type { MemoLookupWith } from "./memo";
export { scriptEvalNode, scriptEvalHandler } from "./script-eval";
export type { ScriptEvalWith } from "./script-eval";
export {
  synthesizeScriptNode,
  synthesizeScriptHandler,
  synthesizeCompleteNode,
  synthesizeCompleteHandler,
  extractSource,
} from "./synthesize";
export type { SynthesizeScriptWith } from "./synthesize";
export {
  promoteApplyNode,
  promoteApplyHandler,
  promoteCompleteNode,
  promoteCompleteHandler,
  demoteApplyNode,
  demoteApplyHandler,
  demoteCompleteNode,
  demoteCompleteHandler,
} from "./promote";
export type { PromoteApplyWith, DemoteApplyWith } from "./promote";
export { featureRefNode, featureRefHandler } from "./feature-ref";
export type { FeatureRefWith } from "./feature-ref";

/**
 * Registriert die built-in Nodes (transform, validate, approval, subworkflow, llm, agent, router,
 * condition, file, db, batch) an der gegebenen Registry. Die Built-ins sind typisiert
 * (NodeDefinition<TransformWith, …>); die Registry hält generische NodeDefinition<unknown, unknown>.
 * Der Cast ist sicher: zur Laufzeit löst `resolveInput` den Input ohnehin dynamisch auf
 * (Inv. 6 — built-in == custom).
 */
export function registerBuiltins(registry: NodeRegistry): void {
  registry.register(transformNode as unknown as NodeDefinition);
  registry.register(validateNode as unknown as NodeDefinition);
  registry.register(approvalNode as unknown as NodeDefinition);
  registry.register(subworkflowNode as unknown as NodeDefinition);
  registry.register(llmNode as unknown as NodeDefinition);
  registry.register(agentNode as unknown as NodeDefinition);
  registry.register(routerNode as unknown as NodeDefinition);
  registry.register(conditionNode as unknown as NodeDefinition);
  registry.register(fileNode as unknown as NodeDefinition);
  registry.register(dbNode as unknown as NodeDefinition);
  registry.register(httpNode as unknown as NodeDefinition);
  registry.register(batchNode as unknown as NodeDefinition);
  registry.register(retroMinerNode as unknown as NodeDefinition);
  registry.register(retroCompleteNode as unknown as NodeDefinition);
  registry.register(memoLookupNode as unknown as NodeDefinition);
  registry.register(scriptEvalNode as unknown as NodeDefinition);
  registry.register(synthesizeScriptNode as unknown as NodeDefinition);
  registry.register(synthesizeCompleteNode as unknown as NodeDefinition);
  registry.register(promoteApplyNode as unknown as NodeDefinition);
  registry.register(promoteCompleteNode as unknown as NodeDefinition);
  registry.register(demoteApplyNode as unknown as NodeDefinition);
  registry.register(demoteCompleteNode as unknown as NodeDefinition);
  registry.register(featureRefNode as unknown as NodeDefinition);
}
