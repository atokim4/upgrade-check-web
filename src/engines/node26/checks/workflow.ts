// GitHub Actions steps around setup-node: package manager caches that need the package manager first, and
// node_modules caches keyed without the Node version.
import { availableAt, type Job, type Model } from "../contexts.ts";
import { lineText } from "../sources.ts";
import type { Finding } from "../types.ts";

const VERSION_IN_KEY = /matrix\.[\w-]*node[\w-]*|node[-_]?version|outputs\.[\w-]*version|nvmrc|node-?\d{2}\b|env\.NODE/i;

function at(job: Job, line: number, rule: string, severity: Finding["severity"], message: string): Finding {
  return { rule, severity, message, file: job.file.path, line, snippet: lineText(job.file.text, line).trim() };
}

export function checkSetupNodeCache(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const job of model.jobs) {
    for (const step of job.setupNode) {
      const cache = step.inputs.cache?.trim();
      if (cache === "pnpm" && !availableAt(job.env, step.at, "pnpm")) {
        out.push(at(job, step.line, "setup-node-cache-before-pm", "error",
          `setup-node has \`cache: pnpm\` but pnpm is not installed yet in job "${job.name}": the step fails with "Unable to locate executable file: pnpm". Put pnpm/action-setup before actions/setup-node.`));
      } else if (cache === "yarn" && !availableAt(job.env, step.at, "yarn")) {
        out.push(at(job, step.line, "setup-node-cache-before-pm", job.container?.major !== undefined && job.container.major >= 26 ? "error" : "warning",
          `setup-node has \`cache: yarn\` in job "${job.name}", which runs in ${job.container?.label ?? "a runner without Yarn"}; node images ship no Yarn as of Node 26. Install Yarn (or corepack) before setup-node.`));
      }
      const major = /^v?(\d+)/.exec(step.ref)?.[1];
      const pm = model.packageManager;
      if (major === "5" && cache === undefined && step.inputs["package-manager-cache"]?.trim() !== "false" && pm && (pm.name === "pnpm" || pm.name === "yarn") && !availableAt(job.env, step.at, pm.name)) {
        out.push(at(job, step.line, "setup-node-v5-auto-cache", "warning",
          `actions/setup-node@${step.ref} caches by itself for "packageManager": "${pm.raw}", and ${pm.name} is not installed before this step in job "${job.name}". Install it first, set \`package-manager-cache: false\`, or move to actions/setup-node@v6+.`));
      }
    }
  }
  return out;
}

export function checkNodeModulesCacheKey(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const job of model.jobs) {
    for (const c of job.caches) {
      if (!/(^|[\s/*])node_modules\b/.test(c.path) || VERSION_IN_KEY.test(c.key)) continue;
      const setup = job.setupNode.filter((s) => s.at < c.at).pop() ?? job.setupNode[0];
      const runtime = job.container ?? setup?.runtime;
      const floating = Boolean(runtime?.floating) || runtime?.major === undefined;
      out.push(at(job, c.line, "node-modules-cache-key", floating ? "warning" : "note",
        `This cache restores node_modules with key \`${c.key || "(none)"}\`, which has no Node version in it; ${
          floating ? `the job runs ${runtime?.label ?? "an unpinned Node"}, so after the move to 26 it restores addons built for another NODE_MODULE_VERSION (147 on Node 26).` : "after you move to Node 26 it restores addons built for the old NODE_MODULE_VERSION (147 on Node 26)."
        } Add the Node version to the key or cache the package manager store instead.`));
    }
  }
  return out;
}
