import { findAccelerateUrls, findGenerateFlags, schemaFindings } from "../engines/prisma/text-rules.ts";
import type { Finding as PrismaFinding } from "../engines/prisma/types.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding, Severity } from "../lib/types.ts";
import { codeLines, filesWhere, isEnvExample, isPackageJson, isSource, snippetOf } from "./text.ts";

const EXTENSION = "@prisma/extension-accelerate";
const KEEP_DB = "https://www.prisma.io/docs/accelerate/keep-your-database";
const SWITCH = "https://www.prisma.io/docs/postgres/database/switch-from-accelerate";

interface Rule {
  title: string;
  why: string;
  fix: string;
  source: string;
}

/** Rule ids and texts follow prisma-accelerate-exit; the source-code rules here are regex stand-ins for its AST pass. */
export const RULES: Record<string, Rule> = {
  dependency: {
    title: `\`${EXTENSION}\` is a dependency`,
    why: "Standalone Prisma Accelerate shuts down on 2026-12-01. The extension sends every query through Accelerate, so they fail once it is gone.",
    fix: `Remove \`.$extends(withAccelerate())\`, point \`DATABASE_URL\` at the database itself, then uninstall \`${EXTENSION}\`.`,
    source: KEEP_DB,
  },
  "extension-import": {
    title: "Imports the Accelerate extension",
    why: "The import goes with the `withAccelerate()` call it feeds.",
    fix: "Delete the import once no `.$extends(withAccelerate())` is left.",
    source: KEEP_DB,
  },
  "extends-call": {
    title: "`.$extends(withAccelerate())` on the Prisma Client",
    why: "This is what routes queries through Accelerate.",
    fix: "Use the plain client: `new PrismaClient()` without the `$extends` call. The client's type changes, so re-run `tsc` after.",
    source: KEEP_DB,
  },
  "accelerate-url-option": {
    title: "`accelerateUrl` passed to `PrismaClient`",
    why: "On Prisma ORM 7 this option is how the client reaches Accelerate.",
    fix: "Pass a driver adapter instead (`@prisma/adapter-pg`, `-mariadb` or `-ppg`) built from the direct database URL.",
    source: SWITCH,
  },
  "cache-strategy": {
    title: "`cacheStrategy` on a query",
    why: "`cacheStrategy` exists only on the Accelerate-extended client. Without it the argument stops compiling, and the query hits the database every time.",
    fix: "Drop the argument, or put a cache of your own (Redis, an in-memory LRU) in front of that query.",
    source: KEEP_DB,
  },
  "cache-invalidate": {
    title: "`$accelerate.invalidate()` call",
    why: "There is no Accelerate cache to invalidate once the extension is gone.",
    fix: "Remove the call, or invalidate your replacement cache here.",
    source: KEEP_DB,
  },
  "accelerate-info": {
    title: "`.withAccelerateInfo()` call",
    why: "It returns `{ data, info }` instead of the plain result, and it disappears with the extension.",
    fix: "Call the query directly and update the code that reads `.data` / `.info`.",
    source: KEEP_DB,
  },
  "edge-client-import": {
    title: "Imports `@prisma/client/edge`",
    why: "The edge client has no query engine of its own and only works through Accelerate or a driver adapter.",
    fix: "On ORM 6 with the bundled engine, import from `@prisma/client`. On ORM 7, import from your generator output and pass a driver adapter.",
    source: SWITCH,
  },
  "generate-flag": {
    title: "`prisma generate` with an Accelerate flag",
    why: "`--no-engine`, `--accelerate` and `--data-proxy` build a client without a query engine, which can only talk to Accelerate.",
    fix: "Drop the flag from the `prisma generate` command.",
    source: KEEP_DB,
  },
  "accelerate-url": {
    title: "An Accelerate connection URL",
    why: "`prisma://` and `accelerate.prisma-data.net` URLs point at the hosted service that shuts down.",
    fix: "Use the database's own connection string (for Prisma Postgres, the direct TCP URL from the console).",
    source: SWITCH,
  },
  "engine-type-client": {
    title: '`engineType = "client"` without a driver adapter',
    why: "An engine-less client needs either Accelerate or a driver adapter to reach the database.",
    fix: "Install a driver adapter, or remove the line to use the bundled engine.",
    source: SWITCH,
  },
};

const SEVERITY: Record<PrismaFinding["severity"], Severity> = { action: "error", warn: "warning", info: "note" };

/** `needs`: the file must also match this (comments included), for names that are common outside Prisma. */
const SOURCE_PATTERNS: { rule: string; pattern: RegExp; message: string; needs?: RegExp }[] = [
  {
    rule: "extension-import",
    pattern: /\bfrom\s*["']@prisma\/extension-accelerate["']|\b(?:require|import)\s*\(\s*["']@prisma\/extension-accelerate["']/,
    message: `Imports ${EXTENSION}.`,
  },
  { rule: "extends-call", pattern: /\.\$extends\s*\(\s*withAccelerate\s*\(/, message: ".$extends(withAccelerate()) on the Prisma Client." },
  { rule: "accelerate-url-option", pattern: /\baccelerateUrl\s*[:,}]/, needs: /PrismaClient/, message: "accelerateUrl option: Prisma ORM 7 needs a driver adapter instead." },
  { rule: "cache-strategy", pattern: /\bcacheStrategy\s*[:,}]/, message: "cacheStrategy on a query: without Accelerate it stops compiling, and the query is no longer cached." },
  { rule: "cache-invalidate", pattern: /\$accelerate\s*\.\s*invalidate(?:All)?\s*\(/, message: "$accelerate.invalidate() has nothing to invalidate once Accelerate is gone." },
  { rule: "accelerate-info", pattern: /\.withAccelerateInfo\s*\(/, message: ".withAccelerateInfo() returns { data, info }; callers need the plain result." },
  { rule: "edge-client-import", pattern: /["']@prisma\/client\/edge(?:\.js)?["']/, message: "Imports the engine-less edge client." },
];

/** Where build flags and Accelerate URLs hide outside the source code. */
function isConfigText(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (isEnvExample(path) || isPackageJson(path)) return true;
  if (/^Dockerfile|\.dockerfile$|^Containerfile/i.test(name)) return true;
  if (/^(?:docker-)?compose.*\.ya?ml$/i.test(name)) return true;
  if (/^(?:vercel|netlify|turbo|nx|railway|render)\.json$|\.toml$/i.test(name)) return true;
  if (/^(?:Makefile|Procfile|justfile)$|\.(?:sh|bash)$/i.test(name)) return true;
  return /\.ya?ml$/i.test(name) && /(?:^|\/)\.(?:github|circleci)\//.test(path);
}

function dependencyFindings(path: string, text: string): PrismaFinding[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const declared = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((k) => {
    const deps = pkg[k];
    return typeof deps === "object" && deps !== null && EXTENSION in deps;
  });
  if (!declared) return [];
  const lines = text.split("\n");
  const index = lines.findIndex((l) => l.includes(`"${EXTENSION}"`));
  return [{ rule: "dependency", severity: "action", fix: "manual", file: path, line: index + 1, message: `${EXTENSION} is in package.json.`, snippet: lines[index]?.trim() }];
}

function hasDriverAdapter(repo: LoadedRepo): boolean {
  return filesWhere(repo, isPackageJson).some((f) => /"@prisma\/adapter-[\w-]+"\s*:/.test(f.text));
}

/** A Prisma dependency or schema: source-code patterns only count in such a repo. */
function usesPrisma(repo: LoadedRepo): boolean {
  return repo.paths.some((p) => p.endsWith(".prisma")) || filesWhere(repo, isPackageJson).some((f) => /"(?:@prisma\/[\w-]+|prisma)"\s*:/.test(f.text));
}

export function check(repo: LoadedRepo): CheckerReport {
  const raw: (PrismaFinding & { approx?: boolean })[] = [];
  const adapter = hasDriverAdapter(repo);

  for (const { path, text } of filesWhere(repo, (p) => p.endsWith(".prisma"))) raw.push(...schemaFindings(path, text, adapter));
  for (const { path, text } of filesWhere(repo, isPackageJson)) raw.push(...dependencyFindings(path, text));

  for (const { path, text } of filesWhere(repo, isConfigText)) {
    for (const hit of findGenerateFlags(text)) {
      raw.push({ rule: "generate-flag", severity: "action", fix: "auto", file: path, line: hit.line, message: `prisma generate ${hit.flag}: builds a client that can only talk to Accelerate.`, snippet: hit.text });
    }
    for (const hit of findAccelerateUrls(text)) {
      raw.push({ rule: "accelerate-url", severity: "action", fix: "manual", file: path, line: hit.line, message: `Accelerate URL ${hit.url}.`, snippet: hit.url });
    }
  }

  const prismaRepo = usesPrisma(repo);
  for (const { path, text } of filesWhere(repo, (p) => prismaRepo && isSource(p))) {
    if (!/prisma|accelerate|cacheStrategy/i.test(text)) continue;
    for (const { line, text: code } of codeLines(path, text)) {
      for (const p of SOURCE_PATTERNS) {
        if (!p.pattern.test(code) || (p.needs && !p.needs.test(text))) continue;
        raw.push({ rule: p.rule as PrismaFinding["rule"], severity: "action", fix: "manual", file: path, line, message: p.message, snippet: snippetOf(code), approx: true });
      }
    }
  }

  const findings: Finding[] = raw.map((f) => {
    const rule = RULES[f.rule]!;
    return { rule: f.rule, severity: SEVERITY[f.severity], title: rule.title, message: f.message, file: f.file, line: f.line, snippet: f.snippet, why: rule.why, fix: rule.fix, sourceUrl: rule.source, approx: f.approx };
  });
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    id: "prisma",
    name: "Prisma Accelerate shutdown",
    about: "Standalone Prisma Accelerate shuts down on 2026-12-01: the extension, cacheStrategy, Accelerate URLs and engine-less generate flags.",
    version: versions.prisma.version,
    repoUrl: `https://github.com/${versions.prisma.repo}`,
    cli: { label: "Fix it on a local checkout", command: `npx github:${versions.prisma.repo} . --fix` },
    rulesChecked: Object.keys(RULES).length,
    findings,
    notes: findings.some((f) => f.approx)
      ? ["Source-code findings here come from text patterns. The CLI reads the TypeScript syntax tree, rewrites the safe cases and also checks edge routes."]
      : [],
  };
}
