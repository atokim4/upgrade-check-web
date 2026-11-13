import { checkWorkflow } from "../engines/n8n/check.ts";
import type { Finding as N8nFinding, Workflow } from "../engines/n8n/types.ts";
import { NODE_RULES, REMOVED_NODES } from "../engines/n8n/rules.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding, Severity } from "../lib/types.ts";
import { filesWhere } from "./text.ts";

const DOCS = "https://docs.n8n.io/changelog/v30-breaking-changes/";
const SEVERITY: Record<N8nFinding["severity"], Severity> = { error: "error", warning: "warning", info: "note" };

function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Workflow).nodes) &&
    (value as Workflow).nodes.every((n) => typeof n === "object" && n !== null && typeof n.type === "string")
  );
}

/**
 * The workflow JSON shapes people commit: a single export, the array `n8n export:workflow --all` writes, a public API
 * list ({ data: [...] }) and a template gallery response ({ workflow: { workflow: {...} } }). Same as n8n-v3-check's
 * load.ts, which also reads the file system and so isn't synced.
 */
export function extractWorkflows(json: unknown): Workflow[] {
  if (Array.isArray(json)) return json.flatMap(extractWorkflows);
  if (isWorkflow(json)) return [json];
  if (typeof json !== "object" || json === null) return [];
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data.flatMap(extractWorkflows);
  if (typeof obj.workflow === "object" && obj.workflow !== null) {
    const outer = obj.workflow as Record<string, unknown>;
    return extractWorkflows(outer.workflow ?? outer);
  }
  return [];
}

/** Line of the node's `"name": "…"` in the file, so the GitHub link lands on the node. */
function nodeLine(text: string, name: string, type: string): number {
  const at = [new RegExp(`"name"\\s*:\\s*${escape(JSON.stringify(name))}`), new RegExp(`"type"\\s*:\\s*${escape(JSON.stringify(type))}`)]
    .map((re) => re.exec(text)?.index)
    .find((i) => i !== undefined);
  return at === undefined ? 1 : text.slice(0, at).split("\n").length;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TITLE: Record<string, string> = {
  "agent-removed-modes-v3": "AI Agent mode removed",
  "agent-node-version-v3": "Old AI Agent version",
  "edit-image-version-v3": "Edit Image v1 removed",
  "gmail-trigger-version-v3": "Gmail Trigger behaviour changes",
  "execute-workflow-source-modes-v3": "Execute Sub-workflow source removed",
  "get-paired-item-v3": "`$getPairedItem` removed",
  "evaluate-expression-code-node-v3": "`$evaluateExpression()` removed from the Code node",
  "always-output-data-multi-output-v3": "“Always Output Data” on a multi-output node",
  "chat-trigger-embedded-json-v3": "Embedded Chat Trigger sends JSON frames",
  "slack-trigger-signature-secret-v3": "Slack Trigger needs a signing secret",
  "unverified-packages-v3": "Unverified community node",
  ...Object.fromEntries(REMOVED_NODES.map((r) => [r.ruleId, `${r.name} node removed`])),
};

const WHY: Record<Severity, string> = {
  error: "On n8n 3.0 this node fails, or the workflow stops activating (n8n's own migration report lists it as executionsFail).",
  warning: "The node keeps running on n8n 3.0 but behaves differently (behaviorChanges in n8n's migration report).",
  note: "Depends on instance settings that workflow JSON doesn't contain, so check it on the instance.",
};

export function check(repo: LoadedRepo): CheckerReport {
  const findings: Finding[] = [];
  let workflows = 0;
  for (const { path, text } of filesWhere(repo, (p) => p.toLowerCase().endsWith(".json"))) {
    if (!text.includes('"nodes"')) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    for (const wf of extractWorkflows(json)) {
      workflows++;
      for (const f of checkWorkflow(wf)) {
        const severity = SEVERITY[f.severity];
        const label = f.disabled ? " (disabled node)" : "";
        findings.push({
          rule: f.ruleId,
          severity,
          title: TITLE[f.ruleId] ?? f.ruleId,
          message: `${wf.name ? `“${wf.name}”, ` : ""}node “${f.nodeName}”${label}: ${f.message}.`,
          file: path,
          line: nodeLine(text, f.nodeName, f.nodeType),
          snippet: f.nodeType + (f.typeVersion === undefined ? "" : ` v${f.typeVersion}`),
          why: WHY[severity],
          fix: f.fix + (f.autoMigratable ? " n8n 2.x Settings > Migration Report can migrate it in one click." : ""),
          sourceUrl: DOCS,
        });
      }
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    id: "n8n",
    name: "n8n 3.0 workflows",
    about: "Nodes, modes and expressions that n8n 3.0 removes or changes, read from the workflow JSON files committed to the repo.",
    version: versions.n8n.version,
    repoUrl: `https://github.com/${versions.n8n.repo}`,
    cli: {
      label: "Full check on a local checkout",
      command: `git clone https://github.com/${versions.n8n.repo} /tmp/n8n-v3-check && (cd /tmp/n8n-v3-check && npm install) && node /tmp/n8n-v3-check/dist/cli.js .`,
    },
    // One NODE_RULES entry is the removed-node lookup itself.
    rulesChecked: REMOVED_NODES.length + NODE_RULES.length - 1,
    findings,
    notes: workflows ? [`Read ${workflows} workflow${workflows === 1 ? "" : "s"}.`] : [],
  };
}
