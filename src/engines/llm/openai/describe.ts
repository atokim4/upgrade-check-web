import { NEEDS_NONE_FOR_CHAT_TOOLS, RESPONSES_ONLY_TOOLS, noticeFor, parseModelId } from "./models.ts";

/** One line about an OpenAI model ID, for the `--model` flag. */
export function describeOpenAIModel(id: string): string {
  const parsed = parseModelId(id);
  if (parsed) {
    const notice = noticeFor(parsed.base)!;
    const past = notice.group === "retired";
    const when = `${past ? "shut down on" : "shuts down on"} ${notice.date}`;
    if (parsed.fineTune) {
      return `${id}: fine-tune of ${parsed.base}, ${when} with its base model; no drop-in replacement ` +
        `(${notice.replacement} has no fine-tuning endpoint)`;
    }
    return `${id}: ${when}; replacement ${notice.replacement}`;
  }
  const bare = id.replace(/^(?:openrouter\/)?openai\//, "");
  if (NEEDS_NONE_FOR_CHAT_TOOLS.has(bare)) {
    return `${id}: reasoning model (default effort medium); on Chat Completions, tools and temperature/top_p/` +
      `logprobs need reasoning_effort "none"`;
  }
  if (RESPONSES_ONLY_TOOLS.has(bare)) {
    return `${id}: reasoning model; tool calling needs the Responses API; temperature/top_p/logprobs only with effort "none" where supported`;
  }
  return `${id}: not on the OpenAI shutdown list this tool knows (as of 2026-11-12)`;
}
