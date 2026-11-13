import { describe, expect, it } from "vitest";
import { check } from "../../src/checkers/gemini.ts";
import { repoOf } from "../helpers/repo.ts";

describe("gemini-25 checker", () => {
  it("finds gemini-2.5-pro and gemini-2.5-flash, routed to other models from 2026-12-01", () => {
    const report = check(
      repoOf({
        "app/llm.py": 'from google import genai\nclient = genai.Client()\nr = client.models.generate_content(model="gemini-2.5-flash", contents=q)\n',
        "src/gemini.ts": 'const model = genAI.getGenerativeModel({ model: "models/gemini-2.5-pro" });\n',
      }),
      "2026-11-13",
    );
    expect(report.findings.map((f) => `${f.rule}@${f.file}:${f.line}`)).toEqual(["gemini-25-routed@app/llm.py:3", "gemini-25-routed@src/gemini.ts:1"]);
    expect(report.findings[0]!.message).toBe("gemini-2.5-flash from 2026-12-01 will be answered by gemini-3.5-flash-lite on the Gemini API.");
    expect(report.findings[1]!.severity).toBe("warning");
    const after = check(repoOf({ "src/gemini.ts": 'model: "gemini-2.5-pro"\n' }), "2026-12-02").findings[0]!;
    expect(after.message).toMatch(/is now answered by gemini-3\.8-flash/);
  });

  it("marks preview IDs past their date as errors", () => {
    const [f] = check(repoOf({ "config.yaml": "model: gemini-2.5-pro-preview-06-05\n" }), "2026-11-13").findings;
    expect(f).toMatchObject({ rule: "gemini-25-shutdown", severity: "error" });
    const [tts] = check(repoOf({ "config.yaml": "tts: gemini-2.5-flash-preview-tts\n" }), "2026-11-13").findings;
    expect(tts).toMatchObject({ severity: "warning" });
    expect(tts!.message).toMatch(/shuts down on 2026-11-17/);
  });

  it("has no false positives: flash-lite, other versions, comments, changelogs, Vertex AI files", () => {
    const report = check(
      repoOf({
        "src/a.ts": 'const m = "gemini-2.5-flash-lite";\nconst n = "gemini-3.8-flash";\n// was gemini-2.5-pro\nconst o = "gemini-2.5-flash_v2";\n',
        "CHANGELOG.md": "moved off gemini-2.5-pro\n",
        "CHANGELOG.json": '{"from": "gemini-2.5-pro"}',
        "vertex/app.py": 'import vertexai\nvertexai.init(project=p)\nmodel = GenerativeModel("gemini-2.5-pro")\n',
      }),
      "2026-11-13",
    );
    expect(report.findings).toEqual([]);
    expect(report.notes.join(" ")).toMatch(/Vertex AI/);
  });
});
