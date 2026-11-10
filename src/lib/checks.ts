import { scanRepo as scanNode26 } from "../engines/node26/engine.ts";
import { planFixes as planNode26Fixes, unifiedDiff } from "../engines/node26/fix.ts";
import { ruleMeta as node26Rule } from "../engines/node26/rules.ts";
import { classify as node26Kind } from "../engines/node26/sources.ts";
import { REPO_URL as NODE26_REPO } from "../engines/node26/version.ts";
import { scanProject } from "../engines/preflight/engine.ts";
import { buildProject, fileKind as preflightKind, utcToday } from "../engines/preflight/model.ts";
import { allRules as preflightRules } from "../engines/preflight/rules/index.ts";
import type { SourceFile as PreflightFile } from "../engines/preflight/types.ts";
import { scanRepo as scanSupabase } from "../engines/supabase-cli-v3/engine.ts";
import { planFixes as planSupabaseFixes } from "../engines/supabase-cli-v3/fix.ts";
import { guideLink, ruleMeta as supabaseRule } from "../engines/supabase-cli-v3/rules.ts";
import { classify as supabaseKind } from "../engines/supabase-cli-v3/sources.ts";
import type { SourceFile as SupabaseFile } from "../engines/supabase-cli-v3/types.ts";
import { REPO_URL as SUPABASE_REPO } from "../engines/supabase-cli-v3/version.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "./loader.ts";

export type Severity = "error" | "warning" | "note";
export type CheckerId = "supabase-cli-v3" | "node26" | "preflight";

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  message: string;
  file: string;
  line: number;
  snippet?: string;
  why: string;
  fix: string;
  /** The changelog, guide or docs section the rule is based on. */
  sourceUrl: string;
  /** A unified diff of this finding's own fix, when the checker can rewrite it safely. */
  diff?: string;
}

export interface CheckerReport {
  id: CheckerId;
  name: string;
  /** What the checker is about, one line. */
  about: string;
  version: string;
  repoUrl: string;
  /** The CLI command that runs the same checks on a local checkout. */
  cli: string;
  rulesChecked: number;
  findings: Finding[];
  /** Every safe fix of this checker as one patch (`git apply`), or undefined when there is none. */
  patch?: string;
  /** Things the reader should know about this run (checks switched off, partial reads). */
  notes: string[];
}

/** The vibe-preflight checks that are about upgrades and dated platform changes. Its security checks stay in the CLI. */
const PREFLIGHT_BREAKING = ["server-adapter-removed", "cron-job-direct-write"];
const PREFLIGHT_GRANTS = ["grants-missing", "grant-leak", "grant-broad"];
const PREFLIGHT_DOCS = "https://github.com/atokim4/vibe-preflight";
const preflightSource = (rule: string) =>
  `${PREFLIGHT_DOCS}#${PREFLIGHT_GRANTS.includes(rule) ? "supabases-2026-10-30-grants-change" : "supabase-breaking-changes-dec-2026"}`;

interface EngineFinding {
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  snippet?: string;
  edits?: { start: number; end: number; text: string; order?: number }[];
}

function diffOf(texts: Map<string, string>, plan: typeof planNode26Fixes, findings: EngineFinding[]): string | undefined {
  const fixes = plan(texts, findings);
  return fixes.length ? fixes.map((f) => unifiedDiff(f.file, f.before, f.after)).join("\n") + "\n" : undefined;
}

function filesOf<K extends string>(repo: LoadedRepo, kindOf: (path: string) => K | undefined) {
  const files: { path: string; text: string; kind: K }[] = [];
  for (const [path, text] of repo.texts) {
    const kind = kindOf(path);
    if (kind) files.push({ path, text, kind });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function supabaseReport(repo: LoadedRepo): CheckerReport {
  const files: SupabaseFile[] = filesOf(repo, supabaseKind);
  const result = scanSupabase({ root: repo.name, files, paths: repo.paths, truncated: repo.listTruncated }, (p) => repo.texts.get(p));
  return {
    id: "supabase-cli-v3",
    name: "Supabase CLI v3",
    about: "Commands, flags and config.toml sections that CLI v3 removed or changed (released 2026-11-02).",
    version: versions["supabase-cli-v3"].version,
    repoUrl: SUPABASE_REPO,
    cli: "npx github:atokim4/supabase-cli-v3-upgrade .",
    rulesChecked: result.rules.length,
    findings: result.findings.map((f) => {
      const meta = supabaseRule(f.rule);
      return { ...f, title: meta.title, why: meta.why, fix: meta.fix, sourceUrl: guideLink(meta.section), diff: f.edits?.length ? diffOf(repo.texts, planSupabaseFixes, [f]) : undefined };
    }),
    patch: diffOf(repo.texts, planSupabaseFixes, result.findings),
    notes: [],
  };
}

function node26Report(repo: LoadedRepo): CheckerReport {
  const files = filesOf(repo, node26Kind);
  const result = scanNode26({ root: repo.name, files, truncated: repo.listTruncated });
  return {
    id: "node26",
    name: "Node.js 26 LTS",
    about: "What breaks when CI, Docker images or code move to Node 26: corepack and Yarn gone, setup-node caching, removed APIs.",
    version: versions.node26.version,
    repoUrl: NODE26_REPO,
    cli: "npx github:atokim4/node26-lts-upgrade .",
    rulesChecked: result.rules.length,
    findings: result.findings.map((f) => {
      const meta = node26Rule(f.rule);
      return { ...f, title: meta.title, why: meta.why, fix: meta.fix, sourceUrl: meta.source, diff: f.edits?.length ? diffOf(repo.texts, planNode26Fixes, [f]) : undefined };
    }),
    patch: diffOf(repo.texts, planNode26Fixes, result.findings),
    notes: result.repoPin ? [`Node version the repo pins: ${result.repoPin}.`] : [],
  };
}

function preflightReport(repo: LoadedRepo, today: string): CheckerReport {
  const notes: string[] = [];
  const wanted = [...PREFLIGHT_BREAKING, ...(repo.plan.sqlComplete ? PREFLIGHT_GRANTS : [])];
  if (!repo.plan.sqlComplete) {
    notes.push(`The grants checks were skipped: the repo has more SQL files than this page reads (${repo.plan.skipped.sql} left out), and they need the whole schema. The CLI reads them all.`);
  }
  const files: PreflightFile[] = filesOf(repo, preflightKind);
  // Every file in a GitHub tree is tracked; for a local folder git's view is unknown.
  const git = repo.source.kind === "github" ? { tracked: new Set(repo.paths), ignored: new Set<string>() } : undefined;
  const project = buildProject(repo.name, files, git, today);
  const result = scanProject(project, preflightRules.map((r) => r.id).filter((id) => !wanted.includes(id)));
  const byId = new Map(preflightRules.map((r) => [r.id, r]));
  return {
    id: "preflight",
    name: "Supabase platform changes",
    about: "@supabase/server adapters removed on 2026-12-01, direct writes to cron.job blocked, and the 2026-10-30 Data API grants change.",
    version: versions.preflight.version,
    repoUrl: PREFLIGHT_DOCS,
    cli: "npx github:atokim4/vibe-preflight --only breaking,grants-missing,grant-leak,grant-broad .",
    rulesChecked: result.rules.length,
    findings: result.findings.map((f) => {
      const rule = byId.get(f.rule)!;
      return { ...f, title: rule.title, why: rule.why, fix: rule.fix, sourceUrl: preflightSource(f.rule) };
    }),
    notes,
  };
}

export interface Report {
  checkers: CheckerReport[];
  /** The day date-based checks were evaluated on (YYYY-MM-DD, UTC). */
  today: string;
}

export function runChecks(repo: LoadedRepo, today: string = utcToday()): Report {
  return { checkers: [supabaseReport(repo), node26Report(repo), preflightReport(repo, today)], today };
}
