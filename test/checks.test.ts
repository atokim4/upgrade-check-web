import { describe, expect, it } from "vitest";
import { runChecks } from "../src/lib/checks.ts";
import type { LoadedRepo } from "../src/lib/loader.ts";
import { planReads } from "../src/lib/select.ts";

/** A small repo with one known hit per checker. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "sample", packageManager: "pnpm@9.15.0", dependencies: { "@supabase/server": "^1.9.0", hono: "^4.6.0" } }, null, 2),
  "Dockerfile": "FROM node:26-alpine\nWORKDIR /app\nCOPY . .\nRUN corepack enable && pnpm install --frozen-lockfile\nCMD [\"node\", \"server.js\"]\n",
  "supabase/config.toml": 'project_id = "sample"\n\n[inbucket]\nenabled = true\nport = 54324\n',
  "src/api.ts": "import { Hono } from 'hono'\nimport { withSupabase } from '@supabase/server/adapters/hono'\n\nconst app = new Hono()\napp.use('*', withSupabase({ auth: 'user' }))\nexport default app\n",
};

function repoOf(files: Record<string, string>): LoadedRepo {
  const tree = Object.entries(files).map(([path, text]) => ({ path, size: text.length }));
  return {
    name: "sample",
    source: { kind: "github", ref: { owner: "o", repo: "sample" }, sha: "b".repeat(40) },
    paths: tree.map((e) => e.path),
    texts: new Map(Object.entries(files)),
    plan: planReads(tree),
    listTruncated: false,
  };
}

describe("runChecks", () => {
  const report = runChecks(repoOf(FILES), "2026-11-10");
  const byId = Object.fromEntries(report.checkers.map((c) => [c.id, c]));

  it("finds the [inbucket] section and offers a patch for it", () => {
    const c = byId["supabase-cli-v3"]!;
    const f = c.findings.find((x) => x.rule === "inbucket-section");
    expect(f).toMatchObject({ file: "supabase/config.toml", line: 3, severity: "error" });
    expect(f!.sourceUrl).toMatch(/^https:\/\/supabase\.com\/docs\/guides\/local-development\/cli\/migrating-to-v3#/);
    expect(f!.diff).toContain("-[inbucket]");
    expect(c.patch).toContain("--- a/supabase/config.toml");
  });

  it("finds corepack on a node:26 image with an install-line fix", () => {
    const f = byId.node26!.findings.find((x) => x.rule === "corepack-not-bundled");
    expect(f).toMatchObject({ file: "Dockerfile", line: 4, severity: "error" });
    expect(f!.diff).toMatch(/\+.*corepack@0\.36\.0/);
  });

  it("finds the @supabase/server adapter import, a warning before 2026-12-01 and an error from it", () => {
    const f = byId.preflight!.findings.find((x) => x.rule === "server-adapter-removed");
    expect(f).toMatchObject({ file: "src/api.ts", severity: "warning" });
    const after = runChecks(repoOf(FILES), "2026-12-02").checkers.find((c) => c.id === "preflight")!;
    expect(after.findings.find((x) => x.rule === "server-adapter-removed")?.severity).toBe("error");
  });

  it("runs only the upgrade checks of vibe-preflight", () => {
    expect(byId.preflight!.rulesChecked).toBe(5);
    expect(byId.preflight!.findings.every((f) => ["server-adapter-removed", "cron-job-direct-write", "grants-missing", "grant-leak", "grant-broad"].includes(f.rule))).toBe(true);
  });

  it("reports a clean repo as clean", () => {
    const clean = runChecks(repoOf({ "package.json": '{"name":"clean"}', "index.js": "console.log(1)\n" }), "2026-11-10");
    expect(clean.checkers.flatMap((c) => c.findings).filter((f) => f.severity !== "note")).toEqual([]);
    expect(clean.checkers.every((c) => c.patch === undefined)).toBe(true);
  });

  it("switches the grants checks off when the SQL wasn't read in full", () => {
    const sql = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`supabase/migrations/${String(i).padStart(3, "0")}_t.sql`, `create table t${i} (id int);\n`]));
    const pf = runChecks(repoOf({ ...FILES, ...sql }), "2026-11-10").checkers.find((c) => c.id === "preflight")!;
    expect(pf.rulesChecked).toBe(2);
    expect(pf.notes.join(" ")).toMatch(/grants checks were skipped/);
  });
});
