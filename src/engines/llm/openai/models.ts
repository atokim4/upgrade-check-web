/**
 * OpenAI model IDs that stopped working or stop soon, from the deprecations page
 * (https://developers.openai.com/api/docs/deprecations), as of 2026-11-14.
 * Azure OpenAI deployments and Bedrock IDs (`openai.gpt-...`) follow their own
 * schedules and are not matched.
 */

/**
 * - `text`: a chat/reasoning model whose replacement takes the same requests once the call-site rules pass,
 *   so `--fix` can swap the ID.
 * - `pro`: gpt-5-pro / o3-pro; the replacement is gpt-6.1-sol with `reasoning.mode: "pro"`, Responses API only.
 * - `image`, `audio`: their own notices; the replacement is a choice or another endpoint, never swapped.
 * - `retired`: already shut down.
 */
export type NoticeGroup = "text" | "pro" | "image" | "audio" | "retired";

export interface OpenAINotice {
  group: NoticeGroup;
  /** ISO date the model stops (or stopped) answering. */
  date: string;
  replacement: string;
  /** The old model reasoned by default (o-series, GPT-5): the replacement's default effort is no change. */
  reasoning: boolean;
}

export const LUNA = "gpt-6-luna";
export const SOL_61 = "gpt-6.1-sol";

/**
 * What a GPT-6 replacement accepts, from its model page and the latest-model guide (see DOCS-NOTES.md).
 * - `none`: takes `reasoning_effort: "none"` (needed for temperature/top_p/logprobs and, on `none-only`
 *   models, for tools on Chat Completions).
 * - `chatTools`: `none-only` = Chat Completions function calling only at effort none; `responses-only` =
 *   tool calling needs the Responses API at any effort.
 */
export interface TargetRules {
  none: boolean;
  chatTools: "none-only" | "responses-only";
  efforts: readonly string[];
}

const ALL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const NO_NONE = ["low", "medium", "high", "xhigh", "max"] as const;

export const TARGETS: ReadonlyMap<string, TargetRules> = new Map<string, TargetRules>([
  ["gpt-6-luna", { none: true, chatTools: "none-only", efforts: ALL_EFFORTS }],
  ["gpt-6-sol", { none: true, chatTools: "none-only", efforts: ALL_EFFORTS }],
  ["gpt-6.1-terra", { none: true, chatTools: "responses-only", efforts: ALL_EFFORTS }],
  ["gpt-6.1-sol", { none: false, chatTools: "responses-only", efforts: NO_NONE }],
  ["gpt-6-astra", { none: false, chatTools: "responses-only", efforts: NO_NONE }],
]);

const notices = new Map<string, OpenAINotice>();
const add = (ids: string[], group: NoticeGroup, date: string, replacement: string, reasoning = false) => {
  for (const id of ids) notices.set(id, { group, date, replacement, reasoning });
};

// 2026-06-11 notice: GPT-5 and o3, off on 2026-12-11.
add(["gpt-5", "gpt-5-2025-08-07", "o3", "o3-2025-04-16"], "text", "2026-12-11", SOL_61, true);
add(["gpt-5-mini", "gpt-5-mini-2025-08-07"], "text", "2026-12-11", "gpt-6.1-terra", true);
add(["gpt-5-nano", "gpt-5-nano-2025-08-07"], "text", "2026-12-11", LUNA, true);
add(["gpt-5-pro", "gpt-5-pro-2025-10-06", "o3-pro", "o3-pro-2025-06-10"], "pro", "2026-12-11", SOL_61, true);

// 2026-10-14 notice: the GPT-4o / GPT-4.1 text models. Fine-tunes follow their base model.
add(
  [
    "gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20",
    "gpt-4o-mini", "gpt-4o-mini-2024-07-18",
    "gpt-4.1", "gpt-4.1-2025-04-14",
    "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14",
  ],
  "text", "2027-01-14", LUNA,
);

// 2026-10-01 notice: GPT-5.1, GPT-5.3 Codex and GPT-5.4 nano, off on 2027-04-01.
add(["gpt-5.1", "gpt-5.1-2025-11-13", "gpt-5.3-codex"], "text", "2027-04-01", "gpt-6-sol", true);
add(["gpt-5.4-nano", "gpt-5.4-nano-2026-03-17"], "text", "2027-04-01", LUNA, true);

// Image models: the replacement is a pick between two models, so nothing is swapped.
const IMAGE_26 = "gpt-image-2.6-sunburst or gpt-image-2.6-flare";
add(["gpt-image-1.5", "gpt-image-1.5-2025-12-16", "gpt-image-1-mini", "chatgpt-image-latest"], "image", "2026-12-01", IMAGE_26);
add(["gpt-image-2", "gpt-image-2-2026-04-21"], "image", "2027-02-10", IMAGE_26);

// Speech, transcription, audio and realtime models: separate notices, separate dates.
add(["tts-1", "tts-1-hd", "gpt-4o-mini-tts", "gpt-4o-mini-tts-2025-03-20", "gpt-4o-mini-tts-2025-12-15"],
  "audio", "2027-01-06", "gpt-realtime-2.1-mini");
add(["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe-2025-12-15", "gpt-4o-transcribe-diarize"],
  "audio", "2027-02-26", "gpt-transcribe or gpt-live-transcribe");
add(["gpt-audio", "gpt-audio-2025-08-28", "gpt-audio-mini", "gpt-audio-mini-2025-12-15", "gpt-4o-audio", "gpt-4o-mini-audio"],
  "audio", "2027-01-20", "gpt-audio-1.5");
add(["gpt-realtime", "gpt-realtime-2025-08-28", "gpt-4o-realtime"], "audio", "2027-01-20", "gpt-realtime-2.1");
add(["gpt-realtime-mini", "gpt-realtime-mini-2025-12-15", "gpt-4o-mini-realtime"], "audio", "2027-01-20", "gpt-realtime-2.1-mini");
add(["gpt-4o-mini-transcribe-2025-03-20"], "audio", "2027-01-20", "gpt-4o-mini-transcribe-2025-12-15 (until 2027-02-26)");

// Already shut down.
add(["gpt-4o-2024-05-13", "gpt-4", "gpt-4-0613", "gpt-4-1106-preview", "gpt-4-turbo", "gpt-4-turbo-2024-04-09",
  "o1", "o1-2024-12-17", "o1-pro", "o1-pro-2025-03-19", "o3-mini", "o3-mini-2025-01-31"],
  "retired", "2026-10-23", "gpt-5.6-sol");
add(["gpt-3.5-turbo", "gpt-3.5-turbo-0125", "o4-mini", "o4-mini-2025-04-16"], "retired", "2026-10-23", "gpt-5.6-terra");
add(["gpt-4.1-nano", "gpt-4.1-nano-2025-04-14"], "retired", "2026-10-23", "gpt-5.6-luna");
add(["gpt-image-1"], "retired", "2026-10-23", "gpt-image-2.5-sunburst or gpt-image-2.5-flare");
add(["gpt-5.2-chat-latest", "gpt-5.3-chat-latest"], "retired", "2026-08-10", "gpt-5.6-sol");
add(["gpt-3.5-turbo-instruct", "gpt-3.5-turbo-1106", "babbage-002", "davinci-002"], "retired", "2026-09-28", "gpt-5.6-terra");
add(["gpt-4o-search-preview", "gpt-4o-search-preview-2025-03-11", "gpt-4o-mini-search-preview",
  "gpt-4o-mini-search-preview-2025-03-11", "computer-use-preview", "computer-use-preview-2025-03-11"],
  "retired", "2026-07-23", "gpt-5.6-terra");
add(["gpt-5-chat-latest", "gpt-5-codex", "gpt-5.1-chat-latest", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.2-codex",
  "o3-deep-research", "o3-deep-research-2025-06-26"], "retired", "2026-07-23", "gpt-5.6-sol");
add(["gpt-5.1-codex-mini"], "retired", "2026-07-23", "gpt-5.6-terra");
add(["gpt-audio-mini-2025-10-06"], "retired", "2026-07-23", "gpt-audio-1.5");
add(["gpt-realtime-mini-2025-10-06"], "retired", "2026-07-23", "gpt-realtime-2.1-mini");
add(["gpt-4-0314", "gpt-4-0125-preview", "gpt-4-turbo-preview"], "retired", "2026-03-26", "gpt-5 or gpt-4.1");
add(["chatgpt-4o-latest"], "retired", "2026-02-17", "gpt-5.1-chat-latest");
add(["gpt-4o-audio-preview", "gpt-4o-mini-audio-preview", "gpt-4o-realtime-preview", "gpt-4o-mini-realtime-preview"],
  "retired", "2026-05-07", "gpt-audio-1.5 / gpt-realtime-1.5");
add(["dall-e-2", "dall-e-3"], "retired", "2026-05-12", "gpt-image-2");

export const OPENAI_NOTICES: ReadonlyMap<string, OpenAINotice> = notices;

/** Dated `-preview` audio/realtime snapshots (e.g. gpt-4o-realtime-preview-2024-12-17) share their family's notice. */
const DATED_PREVIEW = /^(gpt-4o(?:-mini)?-(?:audio|realtime)-preview)-\d{4}-\d{2}-\d{2}$/;

export interface ParsedModelId {
  /** The base OpenAI model ID, e.g. `gpt-4o-mini`. */
  base: string;
  /** `openai/` style prefix kept from the original (LiteLLM, OpenRouter). */
  prefix: string;
  fineTune: boolean;
}

/** Router prefixes that still send the request to OpenAI's own API (`openai:` is the pydantic-ai / LangChain form). */
const PREFIX = /^(?:(?:openrouter\/)?openai\/|openai:)/;

export function stripPrefix(raw: string): string {
  return raw.replace(PREFIX, "");
}

/**
 * Reads a model ID as written in code or config: `gpt-4o`, `openai/gpt-4o`,
 * `openrouter/openai/gpt-4o-mini`, `ft:gpt-4o-mini-2024-07-18:org::abc123`.
 * Returns null for strings that aren't an OpenAI model this tool tracks.
 * IDs match whole: `gpt-5.1` and `gpt-5-codex` have their own rows and never read as `gpt-5`.
 */
export function parseModelId(raw: string): ParsedModelId | null {
  const prefix = PREFIX.exec(raw)?.[0] ?? "";
  let rest = raw.slice(prefix.length);
  let fineTune = false;
  if (rest.startsWith("ft:")) {
    fineTune = true;
    rest = rest.slice(3).split(":")[0] ?? "";
  }
  return noticeFor(rest) ? { base: rest, prefix, fineTune } : null;
}

export function noticeFor(base: string): OpenAINotice | undefined {
  const dated = DATED_PREVIEW.exec(base);
  return OPENAI_NOTICES.get(dated ? dated[1]! : base);
}

const DAY_MS = 86_400_000;
/** A shutdown this close (or already past) is urgent. */
export const URGENT_DAYS = 30;
/** Further out than this, a shutdown is a warning, not an error. */
export const SOON_DAYS = 90;

/** Whole days from `today` (YYYY-MM-DD, UTC) to `date`; negative once it has passed. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** Today's date in UTC as YYYY-MM-DD. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "in 27 days" / "tomorrow" / "today" / "27 days ago". */
export function whenText(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return days > 0 ? `in ${days} days` : `${-days} day${days === -1 ? "" : "s"} ago`;
}
