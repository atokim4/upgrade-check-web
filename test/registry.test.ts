import { describe, expect, it } from "vitest";
import { CHECKERS, runChecks } from "../src/lib/checks.ts";
import { repoOf } from "./helpers/repo.ts";

/** One small hit per detect-only engine. */
const HITS: Record<string, Record<string, string>> = {
  prisma: { "package.json": '{"dependencies":{"@prisma/extension-accelerate":"^2.0.0"}}' },
  llm: { "app.py": 'client.chat.completions.create(model="gpt-4o", messages=m)\n' },
  "gemini-25": { "gemini.py": 'client.models.generate_content(model="gemini-2.5-pro", contents=q)\n' },
  "google-cse": { "search.py": "URL = 'https://www.googleapis.com/customsearch/v1'\n" },
  perspective: { "toxicity.py": "URL = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze'\n" },
  deno: { ".github/workflows/d.yml": "steps:\n  - uses: denoland/deployctl@v1\n" },
  pg18: { "docker-compose.yml": "services:\n  db:\n    image: postgres:18\n    volumes:\n      - d:/var/lib/postgresql/data\nvolumes:\n  d:\n" },
  eslint10: { "eslint.config.mjs": "import js from '@eslint/js'\nexport default [js.configs.recommended]\n", "app/package.json": '{"devDependencies":{"eslint":"^10.0.0"}}' },
  n8n: { "flows/a.json": '{"nodes":[{"name":"c","type":"n8n-nodes-base.cron"}]}' },
};

describe("checker registry", () => {
  it("runs each detect-only engine on its own hit and reports it", async () => {
    for (const [id, files] of Object.entries(HITS)) {
      const report = await runChecks(repoOf(files), "2026-11-13", [id as never]);
      const checker = report.checkers.find((c) => c.id === id);
      expect(checker, id).toBeDefined();
      expect(checker!.findings.filter((f) => f.severity !== "note").length, id).toBeGreaterThan(0);
    }
  });

  it("doesn't load engines whose subject isn't in the repo", async () => {
    const report = await runChecks(repoOf({ "package.json": '{"name":"x"}', "index.js": "console.log(1)\n" }), "2026-11-13");
    expect(report.checkers.map((c) => c.id)).toEqual(["supabase-cli-v3", "node26", "preflight"]);
    expect(report.notUsed.map((c) => c.id)).toEqual(["prisma", "llm", "gemini-25", "google-cse", "perspective", "deno", "pg18", "eslint10", "n8n"]);
  });

  it("limits a scan with `only`", async () => {
    const report = await runChecks(repoOf({ ...HITS.prisma, ...HITS.llm }), "2026-11-13", ["prisma"]);
    expect(report.checkers.map((c) => c.id)).toEqual(["prisma"]);
    expect(report.notUsed).toEqual([]);
  });

  it("gives every detect-only engine a CLI line to the real repo, or the official notice", async () => {
    const all = Object.assign({}, ...Object.values(HITS)) as Record<string, string>;
    const report = await runChecks(repoOf(all), "2026-11-13");
    expect(report.checkers).toHaveLength(CHECKERS.length);
    for (const c of report.checkers) {
      if (c.cli) expect(c.cli.command, c.id).toMatch(/github(?:\.com\/|:)atokim4\//);
      else expect(c.repoUrl, c.id).toMatch(/^https:\/\/(?:ai\.google\.dev|developers\.google\.com)\//);
      expect(c.rulesChecked, c.id).toBeGreaterThan(0);
    }
  });
});
