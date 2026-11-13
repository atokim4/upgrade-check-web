import { describe, expect, it } from "vitest";
import { check, extractWorkflows } from "../../src/checkers/n8n.ts";
import { repoOf } from "../helpers/repo.ts";

const workflow = (nodes: object[], name = "Daily report") => JSON.stringify({ name, nodes, connections: {} }, null, 2);

describe("n8n checker", () => {
  it("finds removed nodes and expressions, with the line of the node", () => {
    const text = workflow([
      { name: "Every morning", type: "n8n-nodes-base.cron", typeVersion: 1, parameters: {} },
      { name: "Shape", type: "n8n-nodes-base.function", typeVersion: 1, parameters: { functionCode: "return items;" } },
      { name: "Set", type: "n8n-nodes-base.set", typeVersion: 3, parameters: { value: "={{ $getPairedItem('A', 0) }}" } },
    ]);
    const report = check(repoOf({ "workflows/report.json": text }));
    expect(report.findings.map((f) => `${f.rule}:${f.line}:${f.severity}`)).toEqual([
      `cron-removed-v3:${text.split("\n").findIndex((l) => l.includes('"Every morning"')) + 1}:error`,
      `function-removed-v3:${text.split("\n").findIndex((l) => l.includes('"Shape"')) + 1}:error`,
      `get-paired-item-v3:${text.split("\n").findIndex((l) => l.includes('"name": "Set"')) + 1}:error`,
    ]);
    expect(report.findings[0]!.fix).toMatch(/Schedule Trigger.*Migration Report/);
    expect(report.findings[0]!.message).toBe("“Daily report”, node “Every morning”: Cron node is removed in n8n 3.0.");
    expect(report.notes).toEqual(["Read 1 workflow."]);
  });

  it("reads the export shapes n8n writes", () => {
    const wf = { nodes: [{ name: "a", type: "n8n-nodes-base.cron" }] };
    expect(extractWorkflows([wf, wf])).toHaveLength(2);
    expect(extractWorkflows({ data: [wf] })).toHaveLength(1);
    expect(extractWorkflows({ workflow: { workflow: wf } })).toHaveLength(1);
  });

  it("has no false positives on a current workflow, sticky notes, other JSON and broken JSON", () => {
    const report = check(
      repoOf({
        "flows/ok.json": workflow([
          { name: "Schedule", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, parameters: {} },
          { name: "Note", type: "n8n-nodes-base.stickyNote", typeVersion: 1, parameters: { content: "we replaced $getPairedItem and the Function node" } },
          { name: "Code", type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode: "return $input.all();" } },
        ]),
        "data/nodes.json": '{"nodes": [1, 2, 3]}',
        "broken.json": '{"nodes": [',
      }),
    );
    expect(report.findings).toEqual([]);
  });
});
