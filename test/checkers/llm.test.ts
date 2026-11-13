import { describe, expect, it } from "vitest";
import { check } from "../../src/checkers/llm.ts";
import { repoOf } from "../helpers/repo.ts";

const found = (files: Record<string, string>) => check(repoOf(files)).findings.map((f) => `${f.rule}@${f.file}:${f.line}`);

describe("llm checker", () => {
  it("finds GPT-4o in a Python call, and the tools trap on the same call", () => {
    const report = check(
      repoOf({
        "app/agent.py": [
          "from openai import OpenAI",
          "client = OpenAI()",
          "resp = client.chat.completions.create(",
          '    model="gpt-4o",',
          "    messages=messages,",
          "    tools=TOOLS,",
          ")",
        ].join("\n"),
      }),
    );
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain("shutdown");
    expect(rules).toContain("tools-effort");
    const shutdown = report.findings.find((f) => f.rule === "shutdown")!;
    expect(shutdown).toMatchObject({ file: "app/agent.py", line: 4, severity: "error" });
    expect(shutdown.message).toMatch(/2027-01-14/);
    expect(report.findings.find((f) => f.rule === "tools-effort")!.message).toMatch(/reasoning_effort "none"/);
  });

  it("flags gpt-6-luna with tools and no reasoning_effort, but not with effort none", () => {
    const call = (extra: string) =>
      `import OpenAI from "openai";\nconst openai = new OpenAI();\nawait openai.chat.completions.create({ model: "gpt-6-luna", messages, tools${extra} });\n`;
    expect(found({ "src/a.ts": call("") })).toContain("tools-effort@src/a.ts:3");
    expect(found({ "src/a.ts": call(', reasoning_effort: "none"') })).not.toContain("tools-effort@src/a.ts:3");
  });

  it("finds Claude Sonnet 4.5 and a retired Claude ID", () => {
    const report = check(
      repoOf({
        "src/claude.ts": 'import Anthropic from "@anthropic-ai/sdk";\nconst model = "claude-sonnet-4-5-20250929";\nconst old = "claude-3-5-sonnet-20241022";\n',
      }),
    );
    expect(report.findings.map((f) => `${f.rule}:${f.line}`)).toEqual(["deprecated-model:2", "retired-model:3"]);
    expect(report.findings[0]!.message).toMatch(/2026-11-30/);
  });

  it("skips tests, fixtures, migrations, changelogs and lockfiles", () => {
    expect(
      found({
        "tests/test_chat.py": 'MODEL = "gpt-4o"\n',
        "src/__mocks__/openai.ts": 'export const model = "gpt-4o";\n',
        "app/migrations/0003_model.py": 'default="gpt-4o"\n',
        "CHANGELOG.md": "- moved off gpt-4o\n",
        "package-lock.json": '{"gpt-4o": 1}',
      }),
    ).toEqual([]);
  });

  it("has no false positives on current models and look-alike strings", () => {
    expect(
      found({
        "src/models.ts": 'export const MODELS = ["gpt-6-luna", "claude-sonnet-5-5", "gpt-4o-like-tokenizer-name"];\n',
        "config.yaml": "model: gpt-5.6-terra\n",
      }),
    ).toEqual([]);
  });
});
