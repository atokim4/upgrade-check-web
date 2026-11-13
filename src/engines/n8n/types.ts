/** The subset of an n8n workflow node the checker reads. */
export interface WorkflowNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  disabled?: boolean;
  alwaysOutputData?: boolean;
  onError?: string;
  parameters?: Record<string, unknown>;
}

export interface Workflow {
  id?: string | number;
  name?: string;
  nodes: WorkflowNode[];
}

/**
 * error   = the node fails or the workflow stops activating on n8n 3.0 (n8n's "executionsFail").
 * warning = the node keeps running but behaves differently (n8n's "behaviorChanges").
 * info    = depends on instance settings this offline check cannot see.
 */
export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  ruleId: string;
  severity: Severity;
  nodeName: string;
  nodeType: string;
  typeVersion?: number;
  disabled: boolean;
  message: string;
  fix: string;
  /** True when n8n 2.x Settings > Migration Report has a one-click migration for this rule (it can still refuse unusual configs). */
  autoMigratable: boolean;
}

export interface WorkflowReport {
  source: string;
  workflowName: string;
  workflowId?: string | number;
  findings: Finding[];
}
