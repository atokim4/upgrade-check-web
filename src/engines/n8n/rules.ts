// Rules mirror n8n's own v3 migration-report rules (packages/cli/src/modules/breaking-changes/rules/v3
// on the n8n 3.x branch). RULES.md lists the source file of every entry. Do not add a node type here
// unless it appears in that rule code.
import type { Finding, Severity, WorkflowNode } from './types.js';

export interface RemovedNode {
  ruleId: string;
  type: string;
  name: string;
  fix: string;
  autoMigratable: boolean;
}

const LC = '@n8n/n8n-nodes-langchain.';
const BASE = 'n8n-nodes-base.';

const removed = (
  ruleId: string,
  type: string,
  name: string,
  fix: string,
  autoMigratable = false,
): RemovedNode => ({ ruleId, type, name, fix, autoMigratable });

const anotherMemory = 'Use another memory node (for example Simple Memory, Postgres or Redis Chat Memory).';
const anotherVectorStore = 'Use another vector store node.';

export const REMOVED_NODES: readonly RemovedNode[] = [
  removed('function-removed-v3', `${BASE}function`, 'Function', 'Code node, mode "Run Once for All Items".'),
  removed('function-item-removed-v3', `${BASE}functionItem`, 'Function Item', 'Code node, mode "Run Once for Each Item".'),
  removed('item-lists-removed-v3', `${BASE}itemLists`, 'Item Lists', 'Split Out, Aggregate, Sort, Limit, Remove Duplicates or Summarize, matching the operation.', true),
  removed('cron-removed-v3', `${BASE}cron`, 'Cron', 'Schedule Trigger.', true),
  removed('interval-removed-v3', `${BASE}interval`, 'Interval', 'Schedule Trigger (fixed clock times; pick a value that divides 60 for even gaps).'),
  removed('html-extract-removed-v3', `${BASE}htmlExtract`, 'HTML Extract', 'HTML node, operation "Extract HTML Content".', true),
  removed('i-calendar-removed-v3', `${BASE}iCal`, 'iCalendar', 'Convert to File node, operation "Convert to ICS".', true),
  removed('convert-to-from-binary-data-removed-v3', `${BASE}moveBinaryData`, 'Convert to/from binary data', 'Convert to File (Base64 to file) or Extract from File (file to Base64).'),
  removed('read-binary-file-removed-v3', `${BASE}readBinaryFile`, 'Read Binary File', 'Read/Write Files from Disk, "Read File(s) From Disk".'),
  removed('read-binary-files-removed-v3', `${BASE}readBinaryFiles`, 'Read Binary Files', 'Read/Write Files from Disk, "Read File(s) From Disk".'),
  removed('write-binary-file-removed-v3', `${BASE}writeBinaryFile`, 'Write Binary File', 'Read/Write Files from Disk, "Write File to Disk".', true),
  removed('read-pdf-removed-v3', `${BASE}readPDF`, 'Read PDF', 'Extract from File node, operation "Extract From PDF".', true),
  removed('workflow-trigger-removed-v3', `${BASE}workflowTrigger`, 'Workflow Trigger', 'n8n Trigger node.', true),
  removed('orbit-removed-v3', `${BASE}orbit`, 'Orbit', 'No replacement: the Orbit service shut down. Remove the node.'),
  removed('openai-removed-v3', `${BASE}openAi`, 'OpenAI (legacy)', 'The current OpenAI node in the AI section.'),
  removed('openai-assistant-removed-v3', `${LC}openAiAssistant`, 'OpenAI Assistant', 'OpenAI node, resource "Assistant".'),
  removed('openai-model-removed-v3', `${LC}lmOpenAi`, 'OpenAI Model', 'OpenAI Chat Model.'),
  removed('http-request-tool-removed-v3', `${LC}toolHttpRequest`, 'HTTP Request Tool (legacy)', 'HTTP Request node connected to the AI Agent Tool input.'),
  removed('serpapi-google-search-removed-v3', `${LC}toolSerpApi`, 'SerpApi (Google Search)', 'No built-in replacement: HTTP Request as a tool against the SerpApi REST API, or the verified SerpApi community node.'),
  removed('manual-chat-trigger-removed-v3', `${LC}manualChatTrigger`, 'Manual Chat Trigger', 'Chat Trigger.'),
  removed('chat-messages-retriever-removed-v3', `${LC}memoryChatRetriever`, 'Chat Messages Retriever', 'Chat Memory Manager, mode "Get Many Messages", or load previous sessions in the Chat Trigger.'),
  removed('motorhead-removed-v3', `${LC}memoryMotorhead`, 'Motorhead', anotherMemory),
  removed('zep-removed-v3', `${LC}memoryZep`, 'Zep', anotherMemory),
  removed('binary-input-loader-removed-v3', `${LC}documentBinaryInputLoader`, 'Binary Input Loader', 'Default Data Loader, type of data "Binary".', true),
  removed('json-input-loader-removed-v3', `${LC}documentJsonInputLoader`, 'JSON Input Loader', 'Default Data Loader, type of data "JSON".', true),
  removed('github-document-loader-removed-v3', `${LC}documentGithubLoader`, 'GitHub Document Loader', 'GitHub node to fetch the content, then Default Data Loader.'),
  removed('in-memory-vector-store-insert-removed-v3', `${LC}vectorStoreInMemoryInsert`, 'In Memory Vector Store Insert', 'Simple Vector Store, operation "Insert Documents".', true),
  removed('in-memory-vector-store-load-removed-v3', `${LC}vectorStoreInMemoryLoad`, 'In Memory Vector Store Load', 'Simple Vector Store, operation "Get Many".', true),
  removed('pinecone-insert-removed-v3', `${LC}vectorStorePineconeInsert`, 'Pinecone: Insert', 'Pinecone Vector Store, operation "Insert Documents".', true),
  removed('pinecone-load-removed-v3', `${LC}vectorStorePineconeLoad`, 'Pinecone: Load', 'Pinecone Vector Store, operation "Get Many".', true),
  removed('supabase-insert-removed-v3', `${LC}vectorStoreSupabaseInsert`, 'Supabase: Insert', 'Supabase Vector Store, operation "Insert Documents".', true),
  removed('supabase-load-removed-v3', `${LC}vectorStoreSupabaseLoad`, 'Supabase: Load', 'Supabase Vector Store, operation "Get Many".', true),
  removed('zep-vector-store-removed-v3', `${LC}vectorStoreZep`, 'Zep Vector Store', anotherVectorStore),
  removed('zep-vector-store-insert-removed-v3', `${LC}vectorStoreZepInsert`, 'Zep Vector Store: Insert', anotherVectorStore),
  removed('zep-vector-store-load-removed-v3', `${LC}vectorStoreZepLoad`, 'Zep Vector Store: Load', anotherVectorStore),
  removed('langchain-code-removed-v3', `${LC}code`, 'LangChain Code', 'No direct replacement: rebuild the logic with other nodes.'),
  removed('ai-transform-deprecated', `${BASE}aiTransform`, 'AI Transform', 'Code node (the Migration Report keeps the generated JavaScript; nodes that never generated code need a hand-written Code node).', true),
];

const REMOVED_BY_TYPE = new Map(REMOVED_NODES.map((r) => [r.type, r]));

export const STICKY_NOTE_TYPE = `${BASE}stickyNote`;
const CORE_PREFIXES = [BASE, LC, 'n8n-nodes-langchain.'];

/** A node from a community package (anything outside n8n's own two node packages). */
export function isCommunityNodeType(type: string): boolean {
  return !CORE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

type NodeFinding = Omit<Finding, 'nodeName' | 'nodeType' | 'typeVersion' | 'disabled'>;

/** A per-node rule. Returns a finding (without node identity) or nothing. */
type NodeRule = (node: WorkflowNode) => NodeFinding | undefined;

const finding = (
  ruleId: string,
  severity: Severity,
  message: string,
  fix: string,
  autoMigratable = false,
): NodeFinding => ({ ruleId, severity, message, fix, autoMigratable });

const version = (node: WorkflowNode) => node.typeVersion ?? 1;

const removedNodeRule: NodeRule = (node) => {
  const rule = REMOVED_BY_TYPE.get(node.type);
  if (!rule) return undefined;
  return finding(rule.ruleId, 'error', `${rule.name} node is removed in n8n 3.0`, rule.fix, rule.autoMigratable);
};

// agent-node-mode.ts: versions below 2 are removed; up to 1.5 an unset `agent` meant Conversational Agent.
const REMOVED_AGENT_MODES: Record<string, string> = {
  conversationalAgent: 'Conversational Agent',
  openAiFunctionsAgent: 'OpenAI Functions Agent',
  planAndExecuteAgent: 'Plan and Execute Agent',
  reActAgent: 'ReAct Agent',
  sqlAgent: 'SQL Agent',
};

const agentRule: NodeRule = (node) => {
  if (node.type !== `${LC}agent` || version(node) >= 2) return undefined;
  const param = node.parameters?.agent;
  const mode = typeof param === 'string' ? param : version(node) <= 1.5 ? 'conversationalAgent' : 'toolsAgent';
  const removedMode = REMOVED_AGENT_MODES[mode];
  if (removedMode) {
    return finding(
      'agent-removed-modes-v3',
      'error',
      `AI Agent v${version(node)} uses the "${removedMode}" mode, which n8n 3.0 removes`,
      'Rebuild it as a current AI Agent (Tools Agent) and reconnect model, memory and tools; SQL Agent needs a Postgres/MySQL tool.',
    );
  }
  return finding(
    'agent-node-version-v3',
    'warning',
    `AI Agent v${version(node)} will run with version 2 behaviour`,
    'Move it to the latest AI Agent version and re-test.',
    true,
  );
};

const editImageRule: NodeRule = (node) =>
  node.type === `${BASE}editImage` && version(node) < 2
    ? finding(
        'edit-image-version-v3',
        'error',
        `Edit Image v${version(node)} is removed (v2 uses a different image library)`,
        'Upgrade the node to version 2, then re-test blur, resize, text and PNG/TIFF quality output.',
        true,
      )
    : undefined;

const gmailTriggerRule: NodeRule = (node) =>
  node.type === `${BASE}gmailTrigger` && version(node) < 1.4
    ? finding(
        'gmail-trigger-version-v3',
        'warning',
        `Gmail Trigger v${version(node)} will run with v1.4 behaviour (max emails per poll, drafts and sent mail excluded)`,
        'Check "Max Emails per Poll" and "Include Drafts"; for sent mail use Schedule Trigger + Gmail "Get Many".',
      )
    : undefined;

const executeWorkflowSourceRule: NodeRule = (node) => {
  const source = node.parameters?.source;
  if (node.type !== `${BASE}executeWorkflow` || (source !== 'localFile' && source !== 'url')) return undefined;
  return finding(
    'execute-workflow-source-modes-v3',
    'error',
    `Execute Sub-workflow uses the removed "${source === 'url' ? 'URL' : 'Local File'}" source`,
    'Import the sub-workflow and pick it with the "Database" source, or paste its JSON with the "Define Below" source ("Parameter" on v1.1 and older).',
  );
};

const getPairedItemRule: NodeRule = (node) =>
  JSON.stringify(node.parameters ?? {}).includes('$getPairedItem')
    ? finding(
        'get-paired-item-v3',
        'error',
        'An expression calls the removed $getPairedItem helper',
        "Use $('Node').item, $('Node').itemMatching(i) or $('Node').pairedItem(i).",
      )
    : undefined;

const evaluateExpressionRule: NodeRule = (node) => {
  if (node.type !== `${BASE}code`) return undefined;
  const language = version(node) === 2 ? (node.parameters?.language ?? 'javaScript') : 'javaScript';
  const code = node.parameters?.jsCode;
  if (language !== 'javaScript' || typeof code !== 'string' || !code.includes('$evaluateExpression')) return undefined;
  return finding(
    'evaluate-expression-code-node-v3',
    'error',
    'Code node calls $evaluateExpression(), which 3.0 removes from the Code node',
    'Evaluate the expression in a node field before the Code node (for example Edit Fields) and read it from the input item.',
  );
};

/**
 * n8n resolves outputs from the installed node descriptions. Offline we only know the core nodes
 * below (checked in n8n's node sources) plus any node routing errors to an extra output.
 * Switch outputs are expression-based, so n8n flags every Switch, and so do we.
 */
function hasMultipleMainOutputs(node: WorkflowNode): boolean {
  if (node.onError === 'continueErrorOutput') return true;
  switch (node.type) {
    case `${BASE}if`:
    case `${BASE}switch`:
    case `${BASE}compareDatasets`:
      return true;
    case `${BASE}splitInBatches`:
      return version(node) >= 2;
    default:
      return false;
  }
}

const alwaysOutputDataRule: NodeRule = (node) =>
  node.alwaysOutputData === true && hasMultipleMainOutputs(node)
    ? finding(
        'always-output-data-multi-output-v3',
        'warning',
        '"Always Output Data" on a node with several outputs: 3.0 adds the empty item only when every output is empty',
        'Review logic downstream of the first output that relied on the empty item.',
      )
    : undefined;

const CHAT_TRIGGER_TYPES = new Set([`${LC}chatTrigger`, 'n8n-nodes-langchain.chatTrigger']);

const chatTriggerEmbeddedRule: NodeRule = (node) =>
  CHAT_TRIGGER_TYPES.has(node.type) && node.parameters?.mode === 'webhook'
    ? finding(
        'chat-trigger-embedded-json-v3',
        'warning',
        'Embedded Chat Trigger: the chat WebSocket now sends JSON frames',
        'Update a pinned @n8n/chat embed to 1.31.0+ or make a custom client parse JSON frames.',
      )
    : undefined;

const slackTriggerRule: NodeRule = (node) =>
  node.type === `${BASE}slackTrigger`
    ? finding(
        'slack-trigger-signature-secret-v3',
        'info',
        'Slack Trigger stops activating if its Slack API credential has no signing secret',
        'Add the Slack app Signing Secret to the credential before upgrading (credentials are not in workflow JSON, so check by hand).',
      )
    : undefined;

const communityNodeRule: NodeRule = (node) =>
  isCommunityNodeType(node.type)
    ? finding(
        'unverified-packages-v3',
        'info',
        'Community node: unverified community packages stop loading by default on 3.0',
        'Use the verified version of the package, or set N8N_UNVERIFIED_PACKAGES_ENABLED=true.',
      )
    : undefined;

export const NODE_RULES: readonly NodeRule[] = [
  removedNodeRule,
  agentRule,
  editImageRule,
  gmailTriggerRule,
  executeWorkflowSourceRule,
  getPairedItemRule,
  evaluateExpressionRule,
  alwaysOutputDataRule,
  chatTriggerEmbeddedRule,
  slackTriggerRule,
  communityNodeRule,
];
