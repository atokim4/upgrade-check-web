#!/usr/bin/env node
// Copies the browser-safe engine modules of the three scanners into src/engines/<id>/.
// Usage: node scripts/sync-engines.mjs [<folder with the three checkouts>]
// Each checkout is found as <folder>/<repo name> or, by default, in the sibling pet folders this repo was built next to.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "engines");
const base = process.argv[2] ? resolve(process.argv[2]) : undefined;

/** `src/` files that need Node (fs, git, CLI, Action, terminal reports); everything else is copied. */
const ENGINES = [
  { id: "supabase-cli-v3", repo: "supabase-cli-v3-upgrade", sibling: "../../../supabase-cli-v3-check/project", skip: ["cli.ts", "fs-repo.ts", "scan.ts", "action", "report"] },
  { id: "node26", repo: "node26-lts-upgrade", sibling: "../../../node26-lts-check/project", skip: ["cli.ts", "fs-repo.ts", "scan.ts", "action", "report"] },
  { id: "preflight", repo: "vibe-preflight", sibling: "../../../vibe-preflight-skill/project", skip: ["cli.ts", "project.ts", "scan.ts", "action", "report.ts", "sarif.ts", "summary.ts"] },
];

const versions = {};
for (const e of ENGINES) {
  const root = base ? join(base, e.repo) : resolve(here, e.sibling);
  if (!existsSync(join(root, "src"))) throw new Error(`${e.repo}: no src/ in ${root}`);
  const dest = join(out, e.id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(join(root, "src"))) {
    if (e.skip.includes(entry)) continue;
    cpSync(join(root, "src", entry), join(dest, entry), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  versions[e.id] = { repo: `atokim4/${e.repo}`, version: pkg.version };
  console.log(`${e.id}: ${pkg.version} from ${relative(process.cwd(), root) || "."}`);
}
writeFileSync(join(out, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
