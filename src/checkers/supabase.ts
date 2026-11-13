import { scanRepo } from "../engines/supabase-cli-v3/engine.ts";
import { planFixes } from "../engines/supabase-cli-v3/fix.ts";
import { guideLink, ruleMeta } from "../engines/supabase-cli-v3/rules.ts";
import { classify } from "../engines/supabase-cli-v3/sources.ts";
import type { SourceFile } from "../engines/supabase-cli-v3/types.ts";
import { REPO_URL } from "../engines/supabase-cli-v3/version.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport } from "../lib/types.ts";
import { diffOf, filesOf } from "./patch.ts";

export function check(repo: LoadedRepo): CheckerReport {
  const files: SourceFile[] = filesOf(repo, classify);
  const result = scanRepo({ root: repo.name, files, paths: repo.paths, truncated: repo.listTruncated }, (p) => repo.texts.get(p));
  return {
    id: "supabase-cli-v3",
    name: "Supabase CLI v3",
    about: "Commands, flags and config.toml sections that CLI v3 removed or changed (released 2026-11-02).",
    version: versions["supabase-cli-v3"].version,
    repoUrl: REPO_URL,
    cli: { label: "Same checks on a local checkout", command: "npx github:atokim4/supabase-cli-v3-upgrade ." },
    rulesChecked: result.rules.length,
    findings: result.findings.map((f) => {
      const meta = ruleMeta(f.rule);
      return { ...f, title: meta.title, why: meta.why, fix: meta.fix, sourceUrl: guideLink(meta.section), diff: f.edits?.length ? diffOf(repo.texts, planFixes, [f]) : undefined };
    }),
    patch: diffOf(repo.texts, planFixes, result.findings),
    notes: [],
  };
}
