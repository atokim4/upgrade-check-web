import { scanRepo } from "../engines/node26/engine.ts";
import { planFixes } from "../engines/node26/fix.ts";
import { ruleMeta } from "../engines/node26/rules.ts";
import { classify } from "../engines/node26/sources.ts";
import { REPO_URL } from "../engines/node26/version.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport } from "../lib/types.ts";
import { diffOf, filesOf } from "./patch.ts";

export function check(repo: LoadedRepo): CheckerReport {
  const files = filesOf(repo, classify);
  const result = scanRepo({ root: repo.name, files, truncated: repo.listTruncated });
  return {
    id: "node26",
    name: "Node.js 26 LTS",
    about: "What breaks when CI, Docker images or code move to Node 26: corepack and Yarn gone, setup-node caching, removed APIs.",
    version: versions.node26.version,
    repoUrl: REPO_URL,
    cli: { label: "Same checks on a local checkout", command: "npx github:atokim4/node26-lts-upgrade ." },
    rulesChecked: result.rules.length,
    findings: result.findings.map((f) => {
      const meta = ruleMeta(f.rule);
      return { ...f, title: meta.title, why: meta.why, fix: meta.fix, sourceUrl: meta.source, diff: f.edits?.length ? diffOf(repo.texts, planFixes, [f]) : undefined };
    }),
    patch: diffOf(repo.texts, planFixes, result.findings),
    notes: result.repoPin ? [`Node version the repo pins: ${result.repoPin}.`] : [],
  };
}
