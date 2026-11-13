import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding, Severity } from "../lib/types.ts";
import { codeLines, filesWhere, snippetOf } from "./text.ts";

export const CSE_DOCS = "https://developers.google.com/custom-search/v1/overview";

const WHY =
  "Google closed the Custom Search JSON API to new customers, and existing ones have until 2027-01-01 to move. After that these requests stop working.";
const FIX =
  "Pick a replacement that fits how you search: Vertex AI Search if you search up to 50 of your own domains (Google's suggestion), a self-hosted SearXNG instance, or a paid web search API such as Brave Search or a SERP API. Results and quotas differ, so compare them on your own queries.";

interface Pattern {
  rule: string;
  title: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
}

const PATTERNS: Pattern[] = [
  {
    rule: "cse-endpoint",
    title: "Calls the Custom Search JSON API endpoint",
    severity: "error",
    pattern: /googleapis\.com\/customsearch\/v1\b/,
    message: "Request to www.googleapis.com/customsearch/v1.",
  },
  {
    rule: "cse-client",
    title: "Builds a Custom Search API client",
    severity: "error",
    pattern: /\bbuild\(\s*["']customsearch["']\s*,\s*["']v1["']|\bgoogle\.customsearch\s*\(|["']@googleapis\/customsearch["']|\bcustomsearch\.cse\.list\b|\.cse\(\)\.list\(/,
    message: "Google API client for customsearch v1.",
  },
  {
    rule: "cse-langchain",
    title: "LangChain Google Search wrapper",
    severity: "error",
    pattern: /\bGoogleSearchAPIWrapper\b|\bGoogleSearchRun\b|\bGoogleSearchResults\b|\bGoogleCustomSearch\b|tools\/google_custom_search\b/,
    message: "LangChain's Google Search tool calls the Custom Search JSON API under the hood.",
  },
  {
    rule: "cse-env",
    title: "Custom Search engine ID setting",
    severity: "warning",
    pattern: /\bGOOGLE_CSE_ID\b|\bGOOGLE_CSE_KEY\b|\bGOOGLE_SEARCH_ENGINE_ID\b/,
    message: "A Programmable Search Engine ID setting: the code that reads it most likely calls the Custom Search JSON API.",
  },
];

const TEXT_FILE = /\.(?:[cm]?[jt]sx?|py|go|rb|php|java|kt|cs|rs|ipynb|ya?ml|toml|json|ini|cfg)$|(?:^|\/)\.env\.(?:example|sample|template|dist)$/i;
const SKIP = /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY)[^/]*$|(?:^|\/)(?:package-lock\.json|poetry\.lock|uv\.lock|pnpm-lock\.yaml)$/i;

export const RULE_COUNT = PATTERNS.length;

export function check(repo: LoadedRepo): CheckerReport {
  const findings: Finding[] = [];
  for (const { path, text } of filesWhere(repo, (p) => TEXT_FILE.test(p) && !SKIP.test(p))) {
    if (!/customsearch|GoogleSearch|GoogleCustomSearch|google_custom_search|GOOGLE_CSE|GOOGLE_SEARCH_ENGINE_ID|\.cse\(\)/.test(text)) continue;
    for (const { line, text: code } of codeLines(path, text)) {
      // One finding per line: the most specific pattern wins.
      const p = PATTERNS.find((x) => x.pattern.test(code));
      if (!p) continue;
      findings.push({ rule: p.rule, severity: p.severity, title: p.title, message: p.message, file: path, line, snippet: snippetOf(code), why: WHY, fix: FIX, sourceUrl: CSE_DOCS });
    }
  }
  return {
    id: "google-cse",
    name: "Google Custom Search JSON API",
    about: "Google ends the Custom Search JSON API for existing customers on 2027-01-01: direct calls, API clients, LangChain's Google Search tool.",
    repoUrl: CSE_DOCS,
    rulesChecked: RULE_COUNT,
    findings,
    notes: [],
  };
}
