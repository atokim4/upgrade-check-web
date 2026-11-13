import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding, Severity } from "../lib/types.ts";
import { codeLines, filesWhere, snippetOf } from "./text.ts";

export const GEMINI_DOCS = "https://ai.google.dev/gemini-api/docs/deprecations";

interface Notice {
  /** ISO date the ID stops answering (or starts being routed to another model). */
  date: string;
  replacement: string;
  /** From the date on, requests are answered by the replacement instead of failing. */
  routed?: boolean;
}

/** Gemini API (AI Studio) 2.5 models with a shutdown date, from the deprecations page as read on 2026-11-13. */
export const GEMINI_25: ReadonlyMap<string, Notice> = new Map([
  ["gemini-2.5-pro", { date: "2026-12-01", replacement: "gemini-3.8-flash", routed: true }],
  ["gemini-2.5-flash", { date: "2026-12-01", replacement: "gemini-3.5-flash-lite", routed: true }],
  ["gemini-2.5-flash-preview-tts", { date: "2026-11-17", replacement: "gemini-3.8-flash-tts or gemini-3.8-flash-lite-tts" }],
  ["gemini-2.5-pro-preview-tts", { date: "2026-11-17", replacement: "gemini-3.8-flash-tts or gemini-3.8-flash-lite-tts" }],
  ["gemini-2.5-flash-native-audio-preview-12-2025", { date: "2026-11-17", replacement: "gemini-3.8-live" }],
  ["gemini-2.5-computer-use-preview-10-2025", { date: "2026-07-28", replacement: "gemini-3.8-flash" }],
  ["gemini-2.5-flash-preview-09-2025", { date: "2026-02-17", replacement: "gemini-3.6-flash" }],
  ["gemini-2.5-flash-lite-preview-09-2025", { date: "2026-03-31", replacement: "gemini-3.1-flash-lite" }],
  ["gemini-2.5-flash-preview-05-20", { date: "2025-11-18", replacement: "gemini-3.6-flash" }],
  ["gemini-2.5-pro-preview-03-25", { date: "2025-12-02", replacement: "gemini-3.8-flash" }],
  ["gemini-2.5-pro-preview-05-06", { date: "2025-12-02", replacement: "gemini-3.8-flash" }],
  ["gemini-2.5-pro-preview-06-05", { date: "2025-12-02", replacement: "gemini-3.8-flash" }],
]);

/** A whole model ID: `gemini-2.5-flash` matches, `gemini-2.5-flash-lite` and `gemini-2.5-flash-001x` are other IDs. */
const MODEL_ID = /(?<![\w.-])gemini-2\.5-[a-z0-9-]*[a-z0-9](?![\w.-]*[\w])/g;
/** Vertex AI has its own model schedule; the same IDs there are not covered by this notice. */
const VERTEX = /\bvertexai\b|vertexai\s*=\s*True|@google-cloud\/vertexai|aiplatform\.googleapis|ChatVertexAI|\bVertexAI\b/;
const PROSE = /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|NEWS|RELEASES?)[^/]*$/i;
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|py|go|rb|php|java|kt|cs|rs|swift|dart|ipynb|ya?ml|toml|json|ini|cfg|env\.[a-z]+)$|(?:^|\/)\.env\.(?:example|sample|template)$/i;

export const RULES = {
  "gemini-25-routed": {
    title: "Gemini 2.5 Pro / Flash model ID",
    why: "From 2026-12-01 the Gemini API answers requests for gemini-2.5-pro with gemini-3.8-flash, and gemini-2.5-flash with gemini-3.5-flash-lite. Nothing errors, so output quality, latency and cost change without a sign in your logs.",
    fix: "Pick the model yourself and test it on your own prompts before the date. gemini-2.5-flash-lite is not deprecated.",
  },
  "gemini-25-shutdown": {
    title: "Gemini 2.5 preview model ID",
    why: "Preview models have their own shutdown dates. After the date, requests to them fail.",
    fix: "Move to the replacement named in the finding.",
  },
} as const;

export function check(repo: LoadedRepo, today: string): CheckerReport {
  const findings: Finding[] = [];
  let vertexOnly = 0;
  for (const { path, text } of filesWhere(repo, (p) => TEXT_FILE.test(p) && !PROSE.test(p))) {
    if (!text.includes("gemini-2.5-")) continue;
    const vertex = VERTEX.test(text);
    for (const { line, text: code } of codeLines(path, text)) {
      for (const match of code.matchAll(MODEL_ID)) {
        const id = match[0];
        const notice = GEMINI_25.get(id);
        if (!notice) continue;
        if (vertex) {
          vertexOnly++;
          continue;
        }
        const past = notice.date <= today;
        const rule = notice.routed ? "gemini-25-routed" : "gemini-25-shutdown";
        const severity: Severity = notice.routed ? "warning" : past ? "error" : "warning";
        const message = notice.routed
          ? `${id} ${past ? "is now" : `from ${notice.date} will be`} answered by ${notice.replacement} on the Gemini API.`
          : `${id} ${past ? "was shut down on" : "shuts down on"} ${notice.date}. Replacement: ${notice.replacement}.`;
        findings.push({ rule, severity, title: RULES[rule].title, message, file: path, line, snippet: snippetOf(code), why: RULES[rule].why, fix: RULES[rule].fix, sourceUrl: GEMINI_DOCS });
      }
    }
  }
  const notes = vertexOnly
    ? [`${vertexOnly} Gemini 2.5 ID${vertexOnly === 1 ? " is" : "s are"} in files that use Vertex AI, which has its own model schedule, so ${vertexOnly === 1 ? "it was" : "they were"} left out.`]
    : [];
  return {
    id: "gemini-25",
    name: "Gemini 2.5 on the Gemini API",
    about: "gemini-2.5-pro and gemini-2.5-flash get routed to other models from 2026-12-01; 2.5 preview IDs shut down on their own dates.",
    repoUrl: GEMINI_DOCS,
    rulesChecked: Object.keys(RULES).length,
    findings,
    notes,
  };
}
