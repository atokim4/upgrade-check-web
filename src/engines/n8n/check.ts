import { NODE_RULES, STICKY_NOTE_TYPE } from './rules.js';
import type { Finding, Severity, Workflow, WorkflowNode } from './types.js';

export interface CheckOptions {
  /** Skip nodes with `disabled: true`. n8n's own report includes them, so the default is false. */
  ignoreDisabled?: boolean;
}

export function checkNode(node: WorkflowNode, options: CheckOptions = {}): Finding[] {
  // Sticky notes are canvas comments: a note that mentions $getPairedItem is documentation, not code.
  if (node.type === STICKY_NOTE_TYPE) return [];
  const disabled = node.disabled === true;
  if (disabled && options.ignoreDisabled) return [];
  return NODE_RULES.flatMap((rule) => {
    const hit = rule(node);
    return hit ? [{ ...hit, nodeName: node.name, nodeType: node.type, typeVersion: node.typeVersion, disabled }] : [];
  });
}

export function checkWorkflow(workflow: Workflow, options: CheckOptions = {}): Finding[] {
  return workflow.nodes.flatMap((node) => checkNode(node, options));
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

/** The most severe level among the findings, or undefined when there are none. */
export function worstSeverity(findings: readonly Finding[]): Severity | undefined {
  return findings.reduce<Severity | undefined>(
    (worst, f) => (worst === undefined || RANK[f.severity] > RANK[worst] ? f.severity : worst),
    undefined,
  );
}
