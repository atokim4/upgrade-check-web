import { extname } from "node:path";

import type { Finding } from "../types.ts";
import { MODEL_NOTICES, acceptsCustomSampling } from "./models.ts";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".php",
  ".java", ".kt", ".cs", ".rs", ".swift", ".vue", ".svelte",
]);

/** Longer lines are minified bundles: findings there point at build output, not source. */
const MAX_LINE_LENGTH = 2_000;

/**
 * A first-party Claude model ID. A `/` before it is allowed (`anthropic/claude-...`
 * in LiteLLM); a `.` or `@` around it marks a Bedrock or Vertex ID, which follow
 * their own retirement schedules and are skipped.
 */
const MODEL_ID = /(?<![\w.@-])claude-[a-z0-9]+(?:[-.][a-z0-9]+)*(?![\w@:-])/gi;
const FIRST_BLOCK_TEXT = /\bcontent["']?\s*\]?\s*\[\s*0\s*\]\s*(?:\?\.\s*text\b|\.\s*text\b|\[\s*["']text["']\s*\])/;
const SAMPLING_KEY = /(?<![\w-])["']?(temperature|top_p|top_k|topP|topK)["']?\s*\]?\s*[:=](?!=)/;
/** `budget_tokens` (Python, JSON), `budgetTokens` (TS, Java, Go), `BudgetTokens` (C#, Go structs). */
const THINKING_BUDGET = /(?<![\w-])["']?(budget_tokens|budgetTokens|BudgetTokens)["']?\s*\]?\s*[:=](?!=)/;
/** A line that is only a comment (`#`, `//`, `/*`, `*`): its text describes code, it isn't code. */
const COMMENT_LINE = /^\s*(?:#|\/\/|\/\*|\*)/;
const MENTIONS_CLAUDE = /anthropic|claude/i;

function noticeFinding(file: string, line: number, id: string): Finding | null {
  const notice = MODEL_NOTICES.get(id.toLowerCase());
  if (!notice) return null;
  const when = notice.date ? ` on ${notice.date}` : " (date not announced yet)";
  return notice.status === "retired"
    ? {
        file, line, provider: "anthropic", rule: "retired-model", severity: "error",
        message: `${id} was retired${when}; requests return 404. Replacement: ${notice.replacement}`,
      }
    : {
        file, line, provider: "anthropic", rule: "deprecated-model", severity: "error",
        message: `${id} retires${when}. Replacement: ${notice.replacement}`,
      };
}

/** Scans one file's text. `file` is only used to label the findings. */
export function scanAnthropic(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isCode = CODE_EXTENSIONS.has(extname(file).toLowerCase());
  const mentionsClaude = MENTIONS_CLAUDE.test(text);
  const lines = text.split(/\r?\n/);

  lines.forEach((content, index) => {
    if (content.length > MAX_LINE_LENGTH) return;
    const line = index + 1;

    for (const match of content.matchAll(MODEL_ID)) {
      const finding = noticeFinding(file, line, match[0]);
      if (finding) findings.push(finding);
    }

    if (!isCode || !mentionsClaude || COMMENT_LINE.test(content)) return;

    if (FIRST_BLOCK_TEXT.test(content)) {
      findings.push({
        file, line, provider: "anthropic", rule: "first-block", severity: "warn",
        message:
          "Reads the first content block as text. With thinking on (the default on Claude 5.x) " +
          "the reply can start with a thinking block; take the first block whose type is \"text\".",
      });
    }

    const sampling = SAMPLING_KEY.exec(content);
    if (sampling) {
      findings.push({
        file, line, provider: "anthropic", rule: "sampling", severity: "warn",
        message:
          `Sets ${sampling[1]}. Claude Opus 4.7 and later refuse a non-default value (400), and ` +
          "API version 2026-10-21 refuses the field on every model. Skip it for those models.",
      });
    }

    if (THINKING_BUDGET.test(content)) {
      findings.push({
        file, line, provider: "anthropic", rule: "manual-thinking", severity: "warn",
        message:
          "Sets a thinking budget (thinking type \"enabled\"). Claude Opus 4.7 and later reject it (400); " +
          "use thinking type \"adaptive\" with output_config.effort for those models.",
      });
    }
  });

  return findings;
}

/** Explains whether a model ID may be sent a custom temperature, for the `--model` flag. */
export function describeSampling(modelId: string): string {
  const notice = MODEL_NOTICES.get(modelId);
  if (notice?.status === "retired") {
    return `${modelId}: retired on ${notice.date}; requests fail. Replacement: ${notice.replacement}`;
  }
  const accepts = acceptsCustomSampling(modelId);
  if (accepts === null) return `${modelId}: not a Claude model ID this tool knows how to read`;
  if (notice) {
    const when = notice.date ? `retires on ${notice.date}` : "is deprecated";
    const sampling = accepts ? "accepts a custom temperature / top_p / top_k" : "accepts only the default sampling settings";
    return `${modelId}: ${when}, replacement ${notice.replacement}; until then it ${sampling}`;
  }
  return accepts
    ? `${modelId}: accepts a custom temperature / top_p / top_k (API version 2023-06-01)`
    : `${modelId}: accepts only the default sampling settings; leave temperature / top_p / top_k out`;
}
