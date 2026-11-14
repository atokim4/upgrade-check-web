import { PERSPECTIVE_SHUTDOWN, scanPerspective } from "../engines/llm/perspective/scan.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding } from "../lib/types.ts";
import { snippetOf } from "./text.ts";
import { scannedByLlm } from "./llm.ts";

const DOCS = "https://perspectiveapi.com/";
const WHY = `Google's Perspective API (Comment Analyzer) answers until ${PERSPECTIVE_SHUTDOWN}, and Google says it won't offer migration support. After that these requests fail.`;
const FIX =
  "Read the base URL from a setting (keep Google's as the default until the day), then point it at a replacement: a server that speaks the same API, or another moderation API with its own response format. Re-check your thresholds on the new scores: a different model puts the same comments on different sides of 0.7.";

const TITLES: Record<string, string> = {
  endpoint: "Hard-coded Perspective API endpoint",
  "google-client": "Perspective through the Google API client",
  "client-package": "Perspective API client package",
  "endpoint-default": "Perspective endpoint as a setting's default",
  "api-key": "Perspective API key setting",
};

export function check(repo: LoadedRepo, today?: string): CheckerReport {
  const findings: Finding[] = [];
  for (const [path, text] of [...repo.texts].sort(([a], [b]) => a.localeCompare(b))) {
    if (!scannedByLlm(path)) continue;
    const lines = text.split(/\r?\n/);
    for (const f of scanPerspective(path, text, today)) {
      const line = lines[f.line - 1];
      findings.push({
        rule: f.rule,
        severity: f.severity === "error" ? "error" : "warning",
        title: TITLES[f.rule] ?? f.rule,
        message: f.message,
        file: f.file,
        line: f.line,
        snippet: line === undefined ? undefined : snippetOf(line),
        why: WHY,
        fix: FIX,
        sourceUrl: DOCS,
      });
    }
  }
  return {
    id: "perspective",
    name: "Google Perspective API shutdown",
    about: `Perspective (commentanalyzer.googleapis.com) answers until ${PERSPECTIVE_SHUTDOWN}: hard-coded endpoints, the Google API client, client packages and key settings.`,
    version: versions.llm.version,
    repoUrl: `https://github.com/${versions.llm.repo}`,
    cli: { label: "Scan a local checkout (Node 22.18+)", command: `git clone https://github.com/${versions.llm.repo} /tmp/llm-retire-scan && node /tmp/llm-retire-scan/src/cli.ts . --provider perspective` },
    rulesChecked: Object.keys(TITLES).length,
    findings,
    notes: [],
  };
}
