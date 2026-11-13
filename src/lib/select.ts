import { classify as node26Kind, SKIP_DIRS as NODE26_SKIP } from "../engines/node26/sources.ts";
import { fileKind as preflightKind } from "../engines/preflight/model.ts";
import { classify as supabaseKind, SKIP_DIRS as SUPABASE_SKIP } from "../engines/supabase-cli-v3/sources.ts";

/** A file in the repository tree. */
export interface TreeEntry {
  path: string;
  /** Bytes. */
  size: number;
}

export type Tier = "config" | "lockfile" | "sql" | "workflow" | "source";

export interface ReadPlan {
  /** Files to read, in the order they should be fetched. */
  read: (TreeEntry & { tier: Tier })[];
  /** Files a check would look at that were left out, by tier. */
  skipped: Record<Tier, number>;
  /** Every SQL migration is in `read`, so the grants checks see the whole schema. */
  sqlComplete: boolean;
}

export interface Limits {
  /** Config, CI and source files together. */
  files: number;
  /** SQL files read. When a repo has more, the checks that need the whole schema are switched off. */
  sql: number;
  lockfiles: number;
  /** JSON files that may be n8n workflow exports (the content decides; the name only ranks them). */
  workflows: number;
}

/** Over the network: few enough files that a scan takes seconds. */
export const GITHUB_LIMITS: Limits = { files: 90, sql: 40, lockfiles: 2, workflows: 15 };
/** A folder on this computer: reading is cheap, so nearly everything. */
export const LOCAL_LIMITS: Limits = { files: 3000, sql: 1000, lockfiles: 4, workflows: 300 };

export const MAX_BYTES = 1024 * 1024;
export const MAX_LOCK_BYTES = 8 * 1024 * 1024;

export const SKIP_DIRS = new Set([...SUPABASE_SKIP, ...NODE26_SKIP, ".cache", ".expo", ".svelte-kit", "out", "playwright-report", "test-results"]);
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lock"]);

/** Config files the newer engines read: Prisma schemas, deno.json, Compose/Helm/Kubernetes YAML, env examples, model settings. */
const EXTRA_CONFIG = [
  /\.prisma$/,
  /(?:^|\/)deno\.jsonc?$/,
  /(?:^|\/)(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i,
  /(?:^|\/)values(?:[.-][\w.-]+)?\.ya?ml$/,
  /(?:^|\/)(?:k8s|kubernetes|kube|manifests|deploy|deployment|helm|charts?)\/(?:[^/]+\/)*[^/]+\.ya?ml$/,
  /(?:^|\/)\.env\.(?:example|sample|template|dist)$/i,
  /(?:^|\/)(?:config|settings|models?|llm|agents?|litellm[^/]*)\.(?:ya?ml|toml|ini|cfg)$/i,
  /(?:^|\/)(?:pyproject\.toml|requirements[^/]*\.txt)$/,
];
const PYTHON = /\.py$/;
/** JSON that is never an n8n workflow. */
const NOT_WORKFLOW = /(?:^|\/)(?:package(?:-lock)?|tsconfig[^/]*|jsconfig|composer|deno|bun|vercel|netlify|turbo|nx|lerna|app|manifest|renovate|\.?eslintrc[^/]*|\.?prettierrc|biome|components|firebase)\.json$|(?:^|\/)(?:\.vscode|\.idea|locales?|i18n|lang|translations?|public|static|assets)\//i;

const depth = (path: string) => path.split("/").length;
export const inSkippedDir = (path: string) => path.split("/").slice(0, -1).some((d) => SKIP_DIRS.has(d));

export function tierOf(path: string): Tier | undefined {
  if (inSkippedDir(path)) return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (LOCKFILES.has(name)) return "lockfile";
  const pf = preflightKind(path);
  if (pf === "sql") return "sql";
  const n26 = node26Kind(path);
  if (supabaseKind(path) || pf === "other" || pf === "env" || (n26 && n26 !== "source" && n26 !== "lockfile")) return "config";
  if (EXTRA_CONFIG.some((re) => re.test(path))) return "config";
  if (n26 === "source" || pf === "source" || PYTHON.test(name)) return "source";
  if (name.endsWith(".json") && !NOT_WORKFLOW.test(path)) return "workflow";
  return undefined;
}

/** Workflow exports first: files and folders named after n8n or workflows. */
function workflowRank(path: string): number {
  if (/n8n/i.test(path)) return 0;
  if (/workflow/i.test(path)) return 1;
  return 2;
}

/** Lower is read first: CI and the files that pin versions, then the rest by depth. */
function configRank(path: string): number {
  if (/(^|\/)\.github\/(workflows|actions)\//.test(path)) return 0;
  if (/(^|\/)(Dockerfile[^/]*|[^/]*\.Dockerfile|Containerfile|\.nvmrc|\.node-version|package\.json|config\.toml)$/.test(path)) return 1;
  return 2;
}

/** Words in a path that point at the code the engines look for: model calls, search clients, database clients. */
const TOPIC = /(?:^|[/_.-])(?:ai|llms?|openai|gpt|claude|anthropic|gemini|google|agents?|chat|bots?|search|retrievers?|tools|providers?|models?|prisma|db|database|config|settings)(?:[/_.-]|$)/i;

/** Source files most likely to hold what the checks look for: Edge Functions and server code first. */
function sourceRank(path: string): number {
  if (/(^|\/)(__tests__|tests?|e2e|fixtures?|__mocks__|examples?)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return 7;
  if (/(^|\/)supabase\/functions\//.test(path)) return 0;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|\/)(server|api|middleware|webhooks?|routes|functions)(\/|\.)/.test(path) || /supabase/i.test(path)) return 1;
  // A file named after the topic (retrievers/google/google.py) beats a folder that merely is (gpt_researcher/...).
  if (TOPIC.test(name)) return 1;
  if (TOPIC.test(path)) return 2;
  if (/(^|\/)scripts\//.test(path) || /^[^/]*\.config\.[cm]?[jt]s$/.test(path)) return 3;
  if (/(^|\/)(src|lib|app)\//.test(path)) return 4;
  return 5;
}

const byRank = (rank: (p: string) => number) => (a: TreeEntry, b: TreeEntry) =>
  rank(a.path) - rank(b.path) || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);

/**
 * Picks which files to read: every config and CI file (up to the file limit), the root lockfiles, all SQL migrations
 * (up to the SQL limit), JSON files that may be n8n workflows (up to their limit), then source files until the file
 * limit is reached.
 */
export function planReads(tree: readonly TreeEntry[], limits: Limits = GITHUB_LIMITS): ReadPlan {
  const groups: Record<Tier, TreeEntry[]> = { config: [], lockfile: [], sql: [], workflow: [], source: [] };
  const skipped: Record<Tier, number> = { config: 0, lockfile: 0, sql: 0, workflow: 0, source: 0 };
  for (const e of tree) {
    const tier = tierOf(e.path);
    // An empty file has nothing to find (and raw.githubusercontent.com sometimes fails on them).
    if (!tier || e.size === 0) continue;
    if (e.size > (tier === "lockfile" ? MAX_LOCK_BYTES : MAX_BYTES)) skipped[tier]++;
    else groups[tier].push(e);
  }

  const take = (tier: Tier, list: TreeEntry[], n: number) => {
    skipped[tier] += Math.max(0, list.length - n);
    return list.slice(0, Math.max(0, n)).map((e) => ({ ...e, tier }));
  };
  const config = take("config", groups.config.sort(byRank(configRank)), limits.files);
  const lockfiles = take("lockfile", groups.lockfile.sort(byRank(() => 0)), limits.lockfiles);
  const sqlComplete = groups.sql.length <= limits.sql && skipped.sql === 0;
  const sql = take("sql", groups.sql.sort((a, b) => a.path.localeCompare(b.path)), limits.sql);
  const workflows = take("workflow", groups.workflow.sort(byRank(workflowRank)), limits.workflows);
  const source = take("source", groups.source.sort(byRank(sourceRank)), limits.files - config.length);
  return { read: [...config, ...lockfiles, ...sql, ...workflows, ...source], skipped, sqlComplete };
}
