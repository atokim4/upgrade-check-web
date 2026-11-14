#!/usr/bin/env node
// Copies the browser-safe engine modules of the scanners into src/engines/<id>/.
// Usage: node scripts/sync-engines.mjs [<folder with the checkouts>]
// Each checkout is found as <folder>/<repo name> or, by default, in the sibling pet folders this repo was built next to.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "engines");
const base = process.argv[2] ? resolve(process.argv[2]) : undefined;

/**
 * `skip`: `src/` entries that need Node (fs, git, CLI, Action, terminal reports); everything else is copied.
 * `only`: copy just these entries (the detect-only engines: their fixers need ts-morph or the file system).
 */
const ENGINES = [
  { id: "supabase-cli-v3", repo: "supabase-cli-v3-upgrade", sibling: "../../../supabase-cli-v3-check/project", skip: ["cli.ts", "fs-repo.ts", "scan.ts", "action", "report"] },
  { id: "node26", repo: "node26-lts-upgrade", sibling: "../../../node26-lts-check/project", skip: ["cli.ts", "fs-repo.ts", "scan.ts", "action", "report"] },
  { id: "preflight", repo: "vibe-preflight", sibling: "../../../vibe-preflight-skill/project", skip: ["cli.ts", "project.ts", "scan.ts", "action", "report.ts", "sarif.ts", "summary.ts"] },
  { id: "prisma", repo: "prisma-accelerate-exit", sibling: "../../../prisma-accelerate-exit/project", only: ["types.ts", "text-rules.ts"] },
  { id: "llm", repo: "llm-retire-scan", sibling: "../../../openai-gpt4-retire/project", only: ["types.ts", "source.ts", "openai", "anthropic", "perspective"] },
  { id: "deno", repo: "deno-exit", sibling: "../../../deno-exit/project", only: ["types.ts", "apis.ts", "specifiers.ts", "deploy.ts"] },
  { id: "pg18", repo: "pg18-upgrade-check", sibling: "../../../pg18-upgrade-check/project", only: ["model.ts", "image.ts", "rules.ts", "sources"] },
  { id: "n8n", repo: "n8n-v3-check", sibling: "../../../n8n-v3-template-census/project", only: ["types.ts", "rules.ts", "check.ts"] },
  // `files`: single files below src/ (the static engine and the shell parser it imports; the rest of the tool needs Node).
  { id: "eslint10", repo: "eslint10-parity", sibling: "../../../eslint10-parity/project", files: ["static/index.ts", "collector/shell.ts"] },
];

const versions = {};
for (const e of ENGINES) {
  const root = base ? join(base, e.repo) : resolve(here, e.sibling);
  if (!existsSync(join(root, "src"))) throw new Error(`${e.repo}: no src/ in ${root}`);
  const dest = join(out, e.id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (e.files) {
    for (const file of e.files) {
      mkdirSync(dirname(join(dest, file)), { recursive: true });
      cpSync(join(root, "src", file), join(dest, file));
    }
  } else {
    for (const entry of readdirSync(join(root, "src"))) {
      if (e.only ? !e.only.includes(entry) : e.skip.includes(entry)) continue;
      cpSync(join(root, "src", entry), join(dest, entry), { recursive: true });
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  versions[e.id] = { repo: `atokim4/${e.repo}`, version: pkg.version };
  console.log(`${e.id}: ${pkg.version} from ${relative(process.cwd(), root) || "."}`);
}
writeFileSync(join(out, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
