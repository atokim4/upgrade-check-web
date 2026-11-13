import { scanProject } from "../engines/preflight/engine.ts";
import { buildProject, fileKind } from "../engines/preflight/model.ts";
import { allRules } from "../engines/preflight/rules/index.ts";
import type { SourceFile } from "../engines/preflight/types.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport } from "../lib/types.ts";
import { filesOf } from "./patch.ts";

/** The vibe-preflight checks that are about upgrades and dated platform changes. Its security checks stay in the CLI. */
export const PREFLIGHT_BREAKING = ["server-adapter-removed", "cron-job-direct-write"];
export const PREFLIGHT_GRANTS = ["grants-missing", "grant-leak", "grant-broad"];
const DOCS = "https://github.com/atokim4/vibe-preflight";
const sourceOf = (rule: string) => `${DOCS}#${PREFLIGHT_GRANTS.includes(rule) ? "supabases-2026-10-30-grants-change" : "supabase-breaking-changes-dec-2026"}`;

export function check(repo: LoadedRepo, today: string): CheckerReport {
  const notes: string[] = [];
  const wanted = [...PREFLIGHT_BREAKING, ...(repo.plan.sqlComplete ? PREFLIGHT_GRANTS : [])];
  if (!repo.plan.sqlComplete) {
    notes.push(`The grants checks were skipped: the repo has more SQL files than this page reads (${repo.plan.skipped.sql} left out), and they need the whole schema. The CLI reads them all.`);
  }
  const files: SourceFile[] = filesOf(repo, fileKind);
  // Every file in a GitHub tree is tracked; for a local folder git's view is unknown.
  const git = repo.source.kind === "github" ? { tracked: new Set(repo.paths), ignored: new Set<string>() } : undefined;
  const project = buildProject(repo.name, files, git, today);
  const result = scanProject(project, allRules.map((r) => r.id).filter((id) => !wanted.includes(id)));
  const byId = new Map(allRules.map((r) => [r.id, r]));
  return {
    id: "preflight",
    name: "Supabase platform changes",
    about: "@supabase/server adapters removed on 2026-12-01, direct writes to cron.job blocked, and the 2026-10-30 Data API grants change.",
    version: versions.preflight.version,
    repoUrl: DOCS,
    cli: { label: "Same checks on a local checkout", command: "npx github:atokim4/vibe-preflight --only breaking,grants-missing,grant-leak,grant-broad ." },
    rulesChecked: result.rules.length,
    findings: result.findings.map((f) => {
      const rule = byId.get(f.rule)!;
      return { ...f, title: rule.title, why: rule.why, fix: rule.fix, sourceUrl: sourceOf(f.rule) };
    }),
    notes,
  };
}
