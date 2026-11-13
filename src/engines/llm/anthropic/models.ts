/**
 * Claude model IDs that no longer work, or stop working soon, on the Claude API.
 *
 * Source: Anthropic's model deprecations page
 * (https://platform.claude.com/docs/en/about-claude/model-deprecations), as of 2026-11-12.
 * Amazon Bedrock and Google Vertex AI keep their own schedules, so IDs in their
 * formats (`anthropic.claude-...-v1:0`, `claude-...@date`) are not listed here.
 */

export type ModelStatus = "retired" | "deprecated";

export interface ModelNotice {
  status: ModelStatus;
  /** ISO date the model stopped (or stops) answering, or null when not announced. */
  date: string | null;
  replacement: string;
}

const retired = (date: string, replacement: string): ModelNotice => ({
  status: "retired",
  date,
  replacement,
});

const deprecated = (date: string | null, replacement: string): ModelNotice => ({
  status: "deprecated",
  date,
  replacement,
});

export const MODEL_NOTICES: ReadonlyMap<string, ModelNotice> = new Map([
  // Deprecated: still answering until the date.
  ["claude-sonnet-4-5-20250929", deprecated("2026-11-30", "claude-sonnet-5-5")],
  ["claude-sonnet-4-5", deprecated("2026-11-30", "claude-sonnet-5-5")],
  ["claude-mythos-preview", deprecated(null, "claude-mythos-5-2 or claude-fable-5-2")],
  // Retired: requests return 404.
  ["claude-opus-4-1-20250805", retired("2026-08-05", "claude-opus-5-5")],
  ["claude-opus-4-1", retired("2026-08-05", "claude-opus-5-5")],
  ["claude-opus-4-20250514", retired("2026-06-15", "claude-opus-5-5")],
  ["claude-opus-4-0", retired("2026-06-15", "claude-opus-5-5")],
  ["claude-sonnet-4-20250514", retired("2026-06-15", "claude-sonnet-5-5")],
  ["claude-sonnet-4-0", retired("2026-06-15", "claude-sonnet-5-5")],
  ["claude-3-haiku-20240307", retired("2026-04-20", "claude-haiku-5-5")],
  ["claude-3-7-sonnet-20250219", retired("2026-02-19", "claude-sonnet-5-5")],
  ["claude-3-7-sonnet-latest", retired("2026-02-19", "claude-sonnet-5-5")],
  ["claude-3-5-haiku-20241022", retired("2026-02-19", "claude-haiku-5-5")],
  ["claude-3-5-haiku-latest", retired("2026-02-19", "claude-haiku-5-5")],
  ["claude-3-opus-20240229", retired("2026-01-05", "claude-opus-5-5")],
  ["claude-3-opus-latest", retired("2026-01-05", "claude-opus-5-5")],
  ["claude-3-5-sonnet-20241022", retired("2025-10-28", "claude-sonnet-5-5")],
  ["claude-3-5-sonnet-20240620", retired("2025-10-28", "claude-sonnet-5-5")],
  ["claude-3-5-sonnet-latest", retired("2025-10-28", "claude-sonnet-5-5")],
  ["claude-3-sonnet-20240229", retired("2025-07-21", "claude-sonnet-5-5")],
  ["claude-2.1", retired("2025-07-21", "claude-opus-5-5")],
  ["claude-2.0", retired("2025-07-21", "claude-opus-5-5")],
]);

/**
 * Whether a Claude model accepts a caller-chosen `temperature` / `top_p` / `top_k`.
 *
 * Claude Opus 4.7 and every later model (Opus 4.8, the 5.x generation, Fable,
 * Mythos) accept only the defaults. Returns null for a string that isn't a Claude
 * model ID this function can place.
 */
export function acceptsCustomSampling(modelId: string): boolean | null {
  const name = modelId.toLowerCase().split("/").pop() ?? "";
  if (/^claude-(fable|mythos)\b/.test(name)) return false;
  if (/^claude-(2|3|instant)\b/.test(name)) return true;
  const match = /^claude-[a-z]+-(\d+)(?:[-.](\d{1,2}))?(?!\d)/.exec(name);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major < 4 || (major === 4 && minor < 7);
}
