/**
 * OpenAI model IDs that stopped working or stop soon, from the deprecations page
 * (https://developers.openai.com/api/docs/deprecations), as of 2026-11-12.
 * Azure OpenAI deployments and Bedrock IDs (`openai.gpt-...`) follow their own
 * schedules and are not matched.
 */

export type NoticeGroup = "text" | "audio" | "retired";

export interface OpenAINotice {
  group: NoticeGroup;
  /** ISO date the model stops (or stopped) answering. */
  date: string;
  replacement: string;
  /** `--fix` swaps the ID to the replacement (only for the 2027-01-14 text family). */
  autoFix: boolean;
}

export const LUNA = "gpt-6-luna";
export const TEXT_SHUTDOWN = "2027-01-14";

const notices = new Map<string, OpenAINotice>();
const add = (ids: string[], group: NoticeGroup, date: string, replacement: string, autoFix = false) => {
  for (const id of ids) notices.set(id, { group, date, replacement, autoFix });
};

// 2026-10-14 notice: the GPT-4o / GPT-4.1 text models. Fine-tunes follow their base model.
add(
  [
    "gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20",
    "gpt-4o-mini", "gpt-4o-mini-2024-07-18",
    "gpt-4.1", "gpt-4.1-2025-04-14",
    "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14",
  ],
  "text", TEXT_SHUTDOWN, LUNA, true,
);

// Speech, transcription, audio and realtime models: separate notices, separate dates.
add(["gpt-4o-mini-tts", "gpt-4o-mini-tts-2025-03-20", "gpt-4o-mini-tts-2025-12-15"],
  "audio", "2027-01-06", "gpt-realtime-2.1-mini");
add(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe-2025-12-15", "gpt-4o-transcribe-diarize"],
  "audio", "2027-02-26", "gpt-transcribe or gpt-live-transcribe");
add(["gpt-4o-audio", "gpt-4o-mini-audio"], "audio", "2027-01-20", "gpt-audio-1.5");
add(["gpt-4o-realtime"], "audio", "2027-01-20", "gpt-realtime-2.1");
add(["gpt-4o-mini-realtime"], "audio", "2027-01-20", "gpt-realtime-2.1-mini");
add(["gpt-4o-mini-transcribe-2025-03-20"], "audio", "2027-01-20", "gpt-4o-mini-transcribe-2025-12-15 (until 2027-02-26)");

// Already shut down.
add(["gpt-4o-2024-05-13", "gpt-4", "gpt-4-0613", "gpt-4-1106-preview", "gpt-4-turbo", "gpt-4-turbo-2024-04-09",
  "o1", "o1-2024-12-17", "o1-pro", "o1-pro-2025-03-19", "o3-mini", "o3-mini-2025-01-31"],
  "retired", "2026-10-23", "gpt-5.6-sol");
add(["gpt-3.5-turbo", "gpt-3.5-turbo-0125", "o4-mini", "o4-mini-2025-04-16"], "retired", "2026-10-23", "gpt-5.6-terra");
add(["gpt-4.1-nano", "gpt-4.1-nano-2025-04-14"], "retired", "2026-10-23", "gpt-5.6-luna");
add(["gpt-image-1"], "retired", "2026-10-23", "gpt-image-2.5-sunburst or gpt-image-2.5-flare");
add(["gpt-3.5-turbo-instruct", "gpt-3.5-turbo-1106", "babbage-002", "davinci-002"], "retired", "2026-09-28", "gpt-5.6-terra");
add(["gpt-4o-search-preview", "gpt-4o-search-preview-2025-03-11", "gpt-4o-mini-search-preview",
  "gpt-4o-mini-search-preview-2025-03-11", "computer-use-preview", "computer-use-preview-2025-03-11"],
  "retired", "2026-07-23", "gpt-5.6-terra");
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

/** Router prefixes that still send the request to OpenAI's own API. */
const PREFIX = /^(?:openrouter\/)?openai\//;

/**
 * Reads a model ID as written in code or config: `gpt-4o`, `openai/gpt-4o`,
 * `openrouter/openai/gpt-4o-mini`, `ft:gpt-4o-mini-2024-07-18:org::abc123`.
 * Returns null for strings that aren't an OpenAI model this tool tracks.
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

/** GPT-6 models that take tools on Chat Completions only with `reasoning_effort: "none"`. */
export const NEEDS_NONE_FOR_CHAT_TOOLS = new Set(["gpt-6-luna", "gpt-6-sol"]);
/** GPT-6 models where tool calling needs the Responses API outright. */
export const RESPONSES_ONLY_TOOLS = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]);
