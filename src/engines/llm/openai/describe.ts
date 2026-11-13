import { TARGETS, daysUntil, noticeFor, parseModelId, stripPrefix, todayUtc, whenText } from "./models.ts";

/** One line about an OpenAI model ID, for the `--model` flag. */
export function describeOpenAIModel(id: string, today: string = todayUtc()): string {
  const parsed = parseModelId(id);
  if (parsed) {
    const notice = noticeFor(parsed.base)!;
    const when = notice.group === "retired"
      ? `shut down on ${notice.date}`
      : `shuts down on ${notice.date} (${whenText(daysUntil(notice.date, today))})`;
    if (parsed.fineTune) {
      return `${id}: fine-tune of ${parsed.base}, ${when} with its base model; no drop-in replacement ` +
        `(${notice.replacement} has no fine-tuning endpoint)`;
    }
    if (notice.group === "pro") {
      return `${id}: ${when}; replacement ${notice.replacement} with reasoning.mode "pro", Responses API only`;
    }
    return `${id}: ${when}; replacement ${notice.replacement}`;
  }
  const bare = stripPrefix(id);
  const rules = TARGETS.get(bare);
  if (rules) {
    const tools = rules.chatTools === "none-only"
      ? 'on Chat Completions, tools need reasoning_effort "none"'
      : "tool calling needs the Responses API";
    const sampling = rules.none
      ? 'temperature/top_p/logprobs need effort "none"'
      : 'no "none" effort, so temperature/top_p/logprobs are rejected';
    return `${id}: reasoning model (default effort medium; takes ${rules.efforts.join(", ")}); ${tools}; ${sampling}`;
  }
  return `${id}: not on the OpenAI shutdown list this tool knows (as of 2026-11-14)`;
}
