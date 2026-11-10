import { classify as node26Kind, SKIP_DIRS as NODE26_SKIP } from "../engines/node26/sources.ts";
import { fileKind as preflightKind } from "../engines/preflight/model.ts";
import { classify as supabaseKind, SKIP_DIRS as SUPABASE_SKIP } from "../engines/supabase-cli-v3/sources.ts";

/** A file in the repository tree. */
export interface TreeEntry {
  path: string;
  /** Bytes. */
  size: number;
}

export type Tier = "config" | "lockfile" | "sql" | "source";

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
}

/** Over the network: few enough files that a scan takes seconds. */
export const GITHUB_LIMITS: Limits = { files: 60, sql: 40, lockfiles: 2 };
/** A folder on this computer: reading is cheap, so nearly everything. */
export const LOCAL_LIMITS: Limits = { files: 3000, sql: 1000, lockfiles: 4 };

export const MAX_BYTES = 1024 * 1024;
export const MAX_LOCK_BYTES = 8 * 1024 * 1024;

export const SKIP_DIRS = new Set([...SUPABASE_SKIP, ...NODE26_SKIP, ".cache", ".expo", ".svelte-kit", "out", "playwright-report", "test-results"]);
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lock"]);

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
  if (n26 === "source" || pf === "source") return "source";
  return undefined;
}

/** Lower is read first: CI and the files that pin versions, then the rest by depth. */
function configRank(path: string): number {
  if (/(^|\/)\.github\/(workflows|actions)\//.test(path)) return 0;
  if (/(^|\/)(Dockerfile[^/]*|[^/]*\.Dockerfile|Containerfile|\.nvmrc|\.node-version|package\.json|config\.toml)$/.test(path)) return 1;
  return 2;
}

/** Source files most likely to hold what the checks look for: Edge Functions and server code first. */
function sourceRank(path: string): number {
  if (/(^|\/)(__tests__|tests?|e2e|fixtures?|__mocks__|examples?)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return 5;
  if (/(^|\/)supabase\/functions\//.test(path)) return 0;
  if (/(^|\/)(server|api|middleware|webhooks?|routes|functions)(\/|\.)/.test(path) || /supabase/i.test(path)) return 1;
  if (/(^|\/)scripts\//.test(path) || /^[^/]*\.config\.[cm]?[jt]s$/.test(path)) return 2;
  if (/(^|\/)(src|lib|app)\//.test(path)) return 3;
  return 4;
}

const byRank = (rank: (p: string) => number) => (a: TreeEntry, b: TreeEntry) =>
  rank(a.path) - rank(b.path) || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);

/**
 * Picks which files to read: every config and CI file (up to the file limit), the root lockfiles, all SQL migrations
 * (up to the SQL limit), then source files until the file limit is reached.
 */
export function planReads(tree: readonly TreeEntry[], limits: Limits = GITHUB_LIMITS): ReadPlan {
  const groups: Record<Tier, TreeEntry[]> = { config: [], lockfile: [], sql: [], source: [] };
  const skipped: Record<Tier, number> = { config: 0, lockfile: 0, sql: 0, source: 0 };
  for (const e of tree) {
    const tier = tierOf(e.path);
    if (!tier) continue;
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
  const source = take("source", groups.source.sort(byRank(sourceRank)), limits.files - config.length);
  return { read: [...config, ...lockfiles, ...sql, ...source], skipped, sqlComplete };
}
