import { scanAnthropic } from "../engines/llm/anthropic/scan.ts";
import { collectDefaults, scanOpenAI } from "../engines/llm/openai/scan.ts";
import type { Finding as LlmFinding } from "../engines/llm/types.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding } from "../lib/types.ts";
import { snippetOf } from "./text.ts";

const OPENAI_DOCS = "https://developers.openai.com/api/docs/deprecations";
const OPENAI_REASONING = "https://developers.openai.com/api/docs/guides/reasoning";
const CLAUDE_DOCS = "https://platform.claude.com/docs/en/about-claude/model-deprecations";
const CLAUDE_MIGRATE = "https://platform.claude.com/docs/en/about-claude/models/migration-guide";

interface Rule {
  title: string;
  why: string;
  fix: string;
  source: string;
}

export const RULES: Record<string, Rule> = {
  shutdown: {
    title: "GPT-4o / GPT-4.1 model ID",
    why: "OpenAI shuts the GPT-4o and GPT-4.1 text models down on 2027-01-14. After that the request fails.",
    fix: "Switch to `gpt-6-luna`. It is a reasoning model, so check the call-site findings for tools, temperature and effort.",
    source: OPENAI_DOCS,
  },
  "audio-shutdown": {
    title: "GPT-4o audio, speech or realtime model ID",
    why: "These models have their own shutdown notices, with dates apart from the text models.",
    fix: "Move to the replacement named in the finding before its date.",
    source: OPENAI_DOCS,
  },
  "fine-tune": {
    title: "Fine-tune of a model that shuts down",
    why: "A fine-tune stops with its base model, and the replacement has no fine-tuning endpoint.",
    fix: "Plan a replacement: prompt the new model with the examples, or fine-tune another model OpenAI still trains.",
    source: OPENAI_DOCS,
  },
  retired: {
    title: "OpenAI model ID that is already shut down",
    why: "Requests to this model fail today.",
    fix: "Use the replacement named in the finding.",
    source: OPENAI_DOCS,
  },
  "tools-effort": {
    title: "Tools on Chat Completions without `reasoning_effort: \"none\"`",
    why: "GPT-6 Luna accepts function tools on Chat Completions only with reasoning effort \"none\". The SDKs leave the default (medium), so a plain ID swap makes the call fail.",
    fix: "Add `reasoning_effort: \"none\"` to the call, or move it to the Responses API to keep reasoning.",
    source: OPENAI_REASONING,
  },
  "tools-responses-only": {
    title: "Tools sent on Chat Completions to a Responses-only model",
    why: "Some GPT-6 models take tool calls only on the Responses API.",
    fix: "Move this call to the Responses API.",
    source: OPENAI_REASONING,
  },
  "sampling-effort": {
    title: "`temperature` / `top_p` on a reasoning model",
    why: "On GPT-6 models these parameters are rejected unless reasoning effort is \"none\".",
    fix: "Set reasoning effort to \"none\", or remove the sampling parameters.",
    source: OPENAI_REASONING,
  },
  "max-tokens": {
    title: "`max_tokens` on a reasoning model",
    why: "`max_tokens` is deprecated in favour of `max_completion_tokens`, and on a reasoning model the limit also has to cover reasoning tokens.",
    fix: "Rename it to `max_completion_tokens` and leave room for reasoning.",
    source: OPENAI_REASONING,
  },
  "default-effort": {
    title: "Runs at the default reasoning effort after the swap",
    why: "GPT-6 Luna defaults to medium effort: slower answers, and reasoning tokens are billed as output.",
    fix: "Set the effort explicitly; \"none\" skips reasoning.",
    source: OPENAI_REASONING,
  },
  "deprecated-model": {
    title: "Claude model ID that retires soon",
    why: "After the retirement date the Claude API answers this model ID with an error.",
    fix: "Move to the replacement named in the finding, then re-test prompts and parameters.",
    source: CLAUDE_DOCS,
  },
  "retired-model": {
    title: "Claude model ID that is already retired",
    why: "Requests to this model return 404 today.",
    fix: "Use the replacement named in the finding.",
    source: CLAUDE_DOCS,
  },
  "first-block": {
    title: "Reads the first content block as the answer",
    why: "With thinking on, a Claude reply can start with a thinking block, so `content[0].text` is empty or missing.",
    fix: "Take the first block whose `type` is `\"text\"`.",
    source: CLAUDE_MIGRATE,
  },
  sampling: {
    title: "Sets `temperature` / `top_p` / `top_k` on Claude",
    why: "Claude Opus 4.7 and later refuse a non-default value with a 400 error.",
    fix: "Send these only to models that accept them, or drop them.",
    source: CLAUDE_MIGRATE,
  },
  "manual-thinking": {
    title: "Manual thinking budget (`budget_tokens`)",
    why: "Claude Opus 4.7 and later reject thinking type \"enabled\" with a budget.",
    fix: "Use thinking type \"adaptive\" with `output_config.effort` for those models.",
    source: CLAUDE_MIGRATE,
  },
};

// The same files llm-retire-scan's directory walk leaves out.
const ISSUE_TEMPLATES = /^\.github\/(?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)/i;
const MIGRATIONS = /(?:^|\/)(?:migrations|alembic\/versions)\/[^/]+\.py$/;
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?|__mocks__|cassettes)\//;
const TEST_FILE = /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.(?:py|go)|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|conftest\.py)$/;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/;
/** A line this long means minified build output. */
const MAX_LINE_LENGTH = 2000;

export function scannedByLlm(path: string): boolean {
  return !(ISSUE_TEMPLATES.test(path) || MIGRATIONS.test(path) || TEST_DIR.test(path) || TEST_FILE.test(path) || LOCKFILE.test(path) || /\.min\.[cm]?js$/.test(path));
}

export function check(repo: LoadedRepo): CheckerReport {
  const files = [...repo.texts].filter(([path]) => scannedByLlm(path)).sort(([a], [b]) => a.localeCompare(b));
  // First pass: a call in one file can take its model from a default set in another.
  const defaults = new Map<string, string>();
  for (const [path, text] of files) collectDefaults(path, text, defaults);

  const raw: (LlmFinding & { snippet?: string })[] = [];
  for (const [path, text] of files) {
    const lines = text.split(/\r?\n/);
    const found: LlmFinding[] = [];
    if (!lines.some((l) => l.length > MAX_LINE_LENGTH)) found.push(...scanOpenAI(path, text, defaults).findings);
    found.push(...scanAnthropic(path, text));
    for (const f of found) raw.push({ ...f, snippet: lines[f.line - 1] === undefined ? undefined : snippetOf(lines[f.line - 1]!) });
  }

  const findings: Finding[] = raw.map((f) => {
    const rule = RULES[f.rule] ?? { title: f.rule, why: "", fix: "", source: f.provider === "openai" ? OPENAI_DOCS : CLAUDE_DOCS };
    return {
      rule: f.rule,
      severity: f.severity === "error" ? "error" : "warning",
      title: rule.title,
      message: f.message,
      file: f.file,
      line: f.line,
      snippet: f.snippet,
      why: rule.why,
      fix: rule.fix,
      sourceUrl: rule.source,
    };
  });
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const fixable = raw.filter((f) => f.fixable).length;
  return {
    id: "llm",
    name: "OpenAI and Claude model retirements",
    about: "GPT-4o / GPT-4.1 shut down on 2027-01-14 (and the gpt-6-luna tools trap), Claude Sonnet 4.5 retires on 2026-11-30, plus IDs already gone.",
    version: versions.llm.version,
    repoUrl: `https://github.com/${versions.llm.repo}`,
    cli: { label: "Fix it on a local checkout (Node 22.18+)", command: `git clone https://github.com/${versions.llm.repo} /tmp/llm-retire-scan && node /tmp/llm-retire-scan/src/cli.ts . --fix` },
    rulesChecked: Object.keys(RULES).length,
    findings,
    notes: fixable ? [`The CLI's --fix rewrites ${fixable} of these lines by itself (ID swaps and reasoning_effort where it is safe).`] : [],
  };
}
