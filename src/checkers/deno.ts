import { API_RULES, ruleKey } from "../engines/deno/apis.ts";
import { scanDeployFile } from "../engines/deno/deploy.ts";
import { planSpecifier } from "../engines/deno/specifiers.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding, Severity } from "../lib/types.ts";
import { codeLines, filesWhere, isPackageJson, snippetOf } from "./text.ts";

const BLOG = "https://deno.com/blog/cloudflare";
const KV_DOCS = "https://docs.deno.com/deploy/kv/node";
const VAL_TOWN = "https://docs.val.town/migration";

interface Rule {
  title: string;
  severity: Severity;
  why: string;
  fix: string;
  source: string;
}

export const RULES: Record<string, Rule> = {
  "deploy-hosting": {
    title: "Deploys to Deno Deploy",
    severity: "error",
    why: 'Deno announced on 2026-10-09 that Deno Deploy runs for six more months; the Deno docs say "Deno Deploy will be sunset in April 2027".',
    fix: "Move hosting first: a Docker image on any host, or Node/Bun/Workers after the code moves. `deno-exit --fix` rewrites the 1:1 parts.",
    source: BLOG,
  },
  "deno-kv": {
    title: "Uses Deno KV",
    severity: "warning",
    why: "Hosted Deno KV goes away with Deno Deploy, and Node has no KV runtime of its own.",
    fix: "Export the data first, then pick a store (Postgres, Redis, Workers KV, SQLite). The Deno docs show how to read KV from Node.",
    source: KV_DOCS,
  },
  "deno-cron": {
    title: "Uses `Deno.cron`",
    severity: "warning",
    why: "`Deno.cron` jobs run inside Deno and Deno Deploy, on UTC schedules.",
    fix: "Move them to the new host's scheduler: Workers Cron Triggers, node-cron with `{ timezone: 'UTC' }`, or a system cron.",
    source: BLOG,
  },
  fresh: {
    title: "Built on Fresh",
    severity: "warning",
    why: "Fresh is Deno's own framework and its docs cover Deno only.",
    fix: "Either keep Fresh on the Deno runtime and move hosting off Deploy (buys time), or port the routes to another framework.",
    source: BLOG,
  },
  "val-town": {
    title: "Imports from Val Town",
    severity: "error",
    why: "Val Town goes read-only on 2026-12-10 and shuts down on 2027-01-10, so its esm.town modules and std services stop loading.",
    fix: "Copy imported vals into the project with their license, and replace Val Town std services (blob, sqlite, email, OpenAI proxy) with your own.",
    source: VAL_TOWN,
  },
  "deno-runtime": {
    title: "Runs on Deno",
    severity: "note",
    why: "The Deno runtime gets one more year of monthly bug and security releases from the 2026-10-09 announcement, then development ends.",
    fix: "If Deno Deploy hosts it through its GitHub integration, nothing in the repo shows that: check the Deploy dashboard, because then the April 2027 sunset applies. Otherwise nothing breaks on a date yet; when you plan the move, `deno-exit` lists every Deno API and import with its Node form.",
    source: BLOG,
  },
};

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DENO_CONFIG = /(?:^|\/)deno\.jsonc?$/;
const DEPLOY_TEXT = /(?:^|\/)(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|Dockerfile[^/]*|[^/]+\.dockerfile|Makefile|[^/]+\.sh)$/;
/** import / export ... from "x", import("x"), and bare side-effect imports. */
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g;
const DENO_MEMBER = /\bDeno\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;
/** Deno's test naming (`*_test.ts`, `*.test.ts`) and test folders: KV and cron there are test setup, not the app. */
const TEST_FILE = /(?:^|\/)(?:tests?|e2e|__tests__|testdata)\/|(?:^|[_.\/])test\.[cm]?[jt]sx?$/;
const FRESH = /^(?:jsr:@fresh\/|\$fresh\/)|deno\.land\/x\/fresh(?:@|\/)/;

function finding(rule: string, file: string, line: number, message: string, snippet?: string, approx?: boolean): Finding {
  const r = RULES[rule]!;
  return { rule, severity: r.severity, title: r.title, message, file, line, snippet, why: r.why, fix: r.fix, sourceUrl: r.source, approx };
}

/** Deploy steps in CI, Dockerfiles, shell scripts and deno.json / package.json tasks. */
function deployFindings(repo: LoadedRepo): Finding[] {
  const out: Finding[] = [];
  for (const { path, text } of filesWhere(repo, (p) => DEPLOY_TEXT.test(p) || DENO_CONFIG.test(p) || isPackageJson(p))) {
    for (const f of scanDeployFile(path, text, "node")) {
      if (f.rule === "deployctl-action" || f.rule === "deployctl") out.push(finding("deploy-hosting", path, f.line, f.message, f.snippet));
    }
    if (DENO_CONFIG.test(path)) {
      const lines = text.split(/\r?\n/);
      const at = lines.findIndex((l) => /^\s*"deploy"\s*:/.test(l));
      if (at !== -1) out.push(finding("deploy-hosting", path, at + 1, 'deno.json has a "deploy" section (the deployctl / Deploy settings).', lines[at]!.trim()));
    }
  }
  return out;
}

interface FileUsage {
  apis: number;
  autoApis: number;
  imports: number;
}

export function check(repo: LoadedRepo): CheckerReport {
  const findings: Finding[] = deployFindings(repo);
  const configs = filesWhere(repo, (p) => DENO_CONFIG.test(p));
  const usage = new Map<string, FileUsage>();
  let freshSeen = false;

  for (const { path, text } of configs) {
    for (const m of text.matchAll(/"((?:jsr:@fresh\/|https:\/\/deno\.land\/x\/fresh)[^"]*)"/g)) {
      if (freshSeen) break;
      freshSeen = true;
      const line = text.slice(0, m.index).split("\n").length;
      findings.push(finding("fresh", path, line, `The import map pulls in Fresh (${m[1]}).`, m[0]));
    }
  }

  for (const { path, text } of filesWhere(repo, (p) => SOURCE.test(p) && !p.endsWith(".d.ts"))) {
    if (!/\bDeno\.|jsr:|npm:|https?:\/\/|\$fresh/.test(text)) continue;
    const u: FileUsage = { apis: 0, autoApis: 0, imports: 0 };
    for (const { line, text: code } of codeLines(path, text)) {
      for (const m of code.matchAll(SPECIFIER)) {
        const spec = m[1]!;
        if (FRESH.test(spec)) {
          if (!freshSeen) findings.push(finding("fresh", path, line, `Imports Fresh (${spec}).`, snippetOf(code)));
          freshSeen = true;
          continue;
        }
        const plan = planSpecifier(spec);
        if (!plan) continue;
        if (plan.kind === "val-town-std" || plan.kind === "esm-town") findings.push(finding("val-town", path, line, plan.message, snippetOf(code)));
        else u.imports++;
      }
      for (const m of code.matchAll(DENO_MEMBER)) {
        const key = ruleKey([m[1]!, ...(m[2] ? [m[2]] : [])]);
        const rule = key ? API_RULES[key] : undefined;
        if ((rule?.rule === "deno-kv" || rule?.rule === "deno-cron") && TEST_FILE.test(path)) continue;
        if (rule?.rule === "deno-kv") {
          if (key === "openKv") findings.push(finding("deno-kv", path, line, "Deno.openKv(): the data lives in Deno KV.", snippetOf(code), true));
        } else if (rule?.rule === "deno-cron") {
          findings.push(finding("deno-cron", path, line, "Deno.cron() schedules a job inside Deno.", snippetOf(code), true));
        } else if (rule) {
          u.apis++;
          if (rule.fix === "auto") u.autoApis++;
        }
      }
    }
    if (u.apis || u.imports) usage.set(path, u);
  }

  const apiTotal = [...usage.values()].reduce((n, u) => n + u.apis, 0);
  const autoTotal = [...usage.values()].reduce((n, u) => n + u.autoApis, 0);
  const importTotal = [...usage.values()].reduce((n, u) => n + u.imports, 0);
  const config = configs[0];
  if (config || usage.size) {
    const where = config?.path ?? [...usage.keys()][0]!;
    const parts = [apiTotal && `${apiTotal} Deno.* uses (${autoTotal} with a 1:1 Node rewrite)`, importTotal && `${importTotal} Deno-style imports (jsr:, npm:, URLs)`].filter(Boolean);
    findings.push(finding("deno-runtime", where, 1, `Deno project${parts.length ? `: ${parts.join(" and ")} in ${usage.size} of the files read` : ""}.`));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    id: "deno",
    name: "Deno Deploy and Val Town",
    about: "Deno Deploy is sunset in April 2027 and Val Town shuts down on 2027-01-10: Deploy steps, Deno KV, Deno.cron, Fresh, Val Town imports.",
    version: versions.deno.version,
    repoUrl: `https://github.com/${versions.deno.repo}`,
    cli: { label: "Move it to Node on a local checkout", command: `npx github:${versions.deno.repo} . --fix` },
    rulesChecked: Object.keys(RULES).length,
    findings,
    notes: findings.some((f) => f.approx) ? ["Deno KV and Deno.cron findings come from text patterns; the CLI reads the syntax tree."] : [],
  };
}
