import type { Finding, Target } from "./types.js";

interface DeployRule {
  rule: string;
  pattern: RegExp;
  message: string;
  replacement: (target: Target) => string;
}

const nodeImage = "node:24-slim with `npm ci` (or `npm ci --omit=dev` in the runtime stage)";

const RULES: DeployRule[] = [
  {
    rule: "deployctl-action",
    pattern: /uses:\s*denoland\/deployctl@/,
    message: "GitHub Action denoland/deployctl deploys to Deno Deploy, which shuts down (docs.deno.com: April 2027)",
    replacement: (t) => (t === "workers" ? "cloudflare/wrangler-action with `wrangler deploy`" : "your new host's deploy step (Docker image, Fly, Render, a VPS …)"),
  },
  {
    rule: "deployctl",
    pattern: /\bdeployctl\s+deploy\b|\bdeno\s+deploy\b/,
    message: "Deno Deploy CLI command",
    replacement: (t) => (t === "workers" ? "`wrangler deploy`" : "your new host's deploy command"),
  },
  {
    rule: "setup-deno",
    pattern: /uses:\s*denoland\/setup-deno@/,
    message: "CI installs Deno",
    replacement: (t) => (t === "bun" ? "oven-sh/setup-bun + `bun install`" : "actions/setup-node (node-version: 24) + `npm ci`"),
  },
  {
    rule: "docker-deno-image",
    pattern: /^\s*FROM\s+(?:--platform=\S+\s+)?(?:docker\.io\/)?denoland\/deno\b/im,
    message: "Docker image based on denoland/deno",
    replacement: (t) => (t === "bun" ? "oven/bun with `bun install --production`" : nodeImage),
  },
  {
    rule: "deno-command",
    pattern: /(?:^|[\s"'`;&|(])deno\s+(?:task|run|test|compile|install|cache|lint|fmt|check|bundle|serve|ci)\b/,
    message: "runs the deno CLI",
    replacement: (t) => (t === "bun" ? "the matching `bun run` / `bun test` command" : "the matching npm script (`npm run <task>`, `npm test`, `npx tsc --noEmit`)"),
  },
];

/** One finding per matched line; a file that says `deno` in a comment is skipped. */
export function scanDeployFile(rel: string, text: string, target: Target): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/^\s*#.*$/, "");
    if (!line.trim()) return;
    for (const r of RULES) {
      if (!r.pattern.test(line)) continue;
      findings.push({
        rule: r.rule,
        category: "deploy",
        fix: "manual",
        file: rel,
        line: i + 1,
        message: r.message,
        replacement: r.replacement(target),
        snippet: raw.trim().slice(0, 100),
      });
      break;
    }
  });
  return findings;
}
