import { utcToday } from "../engines/preflight/model.ts";
import type { LoadedRepo } from "./loader.ts";
import type { CheckerId, CheckerReport } from "./types.ts";

export type { CheckerId, CheckerReport, Finding, Severity } from "./types.ts";

interface CheckerModule {
  check(repo: LoadedRepo, today: string): CheckerReport;
}

export interface CheckerEntry {
  id: CheckerId;
  name: string;
  /**
   * A cheap test on the loaded files: when it fails the engine can't find anything, so its code isn't even downloaded.
   * Each one is a superset of what its engine looks for. Without it the engine always runs.
   */
  uses?: (repo: LoadedRepo) => boolean;
  /** Each engine is its own chunk, fetched the first time a scan needs it. */
  load: () => Promise<CheckerModule>;
}

const anyText = (repo: LoadedRepo, re: RegExp, path: (p: string) => boolean = () => true) =>
  [...repo.texts].some(([p, text]) => path(p) && re.test(text));
const anyPath = (repo: LoadedRepo, re: RegExp) => repo.paths.some((p) => re.test(p));

/** Every checker, in the order the report lists clean ones. */
export const CHECKERS: readonly CheckerEntry[] = [
  { id: "supabase-cli-v3", name: "Supabase CLI v3", load: () => import("../checkers/supabase.ts") },
  { id: "node26", name: "Node.js 26 LTS", load: () => import("../checkers/node26.ts") },
  { id: "preflight", name: "Supabase platform changes", load: () => import("../checkers/preflight.ts") },
  {
    id: "prisma",
    name: "Prisma Accelerate shutdown",
    uses: (r) => anyPath(r, /\.prisma$/) || anyText(r, /@prisma\/|prisma:\/\/|accelerate\.prisma-data\.net|prisma(?:@[\w.^~-]+)?\s+generate/),
    load: () => import("../checkers/prisma.ts"),
  },
  {
    id: "llm",
    name: "OpenAI and Claude model retirements",
    uses: (r) => anyText(r, /gpt-|claude|anthropic|\bo[134]\b|\bo[34]-mini|dall-e|davinci|babbage|computer-use/i),
    load: () => import("../checkers/llm.ts"),
  },
  { id: "gemini-25", name: "Gemini 2.5 on the Gemini API", uses: (r) => anyText(r, /gemini-2\.5-/), load: () => import("../checkers/gemini.ts") },
  {
    id: "google-cse",
    name: "Google Custom Search JSON API",
    uses: (r) => anyText(r, /customsearch|GoogleSearch|GoogleCustomSearch|google_custom_search|GOOGLE_CSE|GOOGLE_SEARCH_ENGINE_ID|\.cse\(\)/),
    load: () => import("../checkers/google-cse.ts"),
  },
  {
    id: "deno",
    name: "Deno Deploy and Val Town",
    uses: (r) => anyPath(r, /(?:^|\/)deno\.jsonc?$/) || anyText(r, /\bDeno\.|deployctl|deno\s+deploy|esm\.town|val\.town|\$fresh\//),
    load: () => import("../checkers/deno.ts"),
  },
  { id: "pg18", name: "Postgres 18 in Docker", uses: (r) => anyText(r, /postgres|postgis|pgvector|timescale/i), load: () => import("../checkers/pg18.ts") },
  {
    id: "eslint10",
    name: "ESLint 10",
    uses: (r) => anyPath(r, /(?:^|\/)(?:\.eslintrc(?:\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|\.eslintignore)$/) || anyText(r, /"eslint"\s*:/, (p) => p.endsWith("package.json")),
    load: () => import("../checkers/eslint10.ts"),
  },
  { id: "n8n", name: "n8n 3.0 workflows", uses: (r) => anyText(r, /"(?:n8n-nodes-|@n8n\/)/, (p) => p.endsWith(".json")), load: () => import("../checkers/n8n.ts") },
];

export interface Report {
  checkers: CheckerReport[];
  /** Checkers whose subject doesn't appear in the files that were read, so they didn't run. */
  notUsed: { id: CheckerId; name: string }[];
  /** The day date-based checks were evaluated on (YYYY-MM-DD, UTC). */
  today: string;
}

/** Runs the checkers (all, or only the ids in `only`) on a loaded repo. */
export async function runChecks(repo: LoadedRepo, today: string = utcToday(), only?: readonly CheckerId[]): Promise<Report> {
  const chosen = CHECKERS.filter((c) => !only?.length || only.includes(c.id));
  const active = chosen.filter((c) => !c.uses || c.uses(repo));
  const modules = await Promise.all(active.map((c) => c.load()));
  return {
    checkers: modules.map((m) => m.check(repo, today)),
    notUsed: chosen.filter((c) => !active.includes(c)).map((c) => ({ id: c.id, name: c.name })),
    today,
  };
}
