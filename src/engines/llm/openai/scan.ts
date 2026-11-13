import { basename, extname } from "node:path";

import {
  type Entry, type Language, type Source, CODE, entries, indentOf, lex, lineOf, matchingClose, enclosingOpen,
} from "../source.ts";
import type { Edit, Finding, Severity } from "../types.ts";
import {
  LUNA, NEEDS_NONE_FOR_CHAT_TOOLS, RESPONSES_ONLY_TOOLS, noticeFor, parseModelId,
} from "./models.ts";

export interface OpenAIScan {
  findings: Finding[];
  edits: Edit[];
}

const PY = new Set([".py"]);
const JS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]);
const OTHER_CODE = new Set([".go", ".rb", ".php", ".java", ".kt", ".cs", ".rs", ".swift", ".dart", ".ex", ".exs"]);
const CONFIG = new Set([".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".json", ".properties", ".env"]);
/** Release notes and docs mention old models on purpose. */
const PROSE_FILE = /^(?:changelog|changes|history|news|releases?)(?:\.|$)/i;

type FileKind = Language | "code" | "config" | "skip";

export function fileKind(file: string): FileKind {
  const name = basename(file);
  if (PROSE_FILE.test(name)) return "skip";
  const ext = extname(name).toLowerCase();
  if (PY.has(ext)) return "py";
  if (JS.has(ext)) return "js";
  if (OTHER_CODE.has(ext)) return "code";
  if (CONFIG.has(ext) || /^\.env(?:\.|$)/.test(name)) return "config";
  return "skip";
}

/** Characters a model ID can be made of, including `openai/` prefixes and `ft:` fine-tune names. */
const TOKEN = /[A-Za-z0-9_.:/-]+/g;
/** Two words in a row: the string is a sentence (a log line, a help text), not a model setting. */
const PROSE = /[A-Za-z]{2,}["'.:;)]*[ \t]+["'(]*[A-Za-z]{2,}/;
const MODEL_LIKE = /^[\w./:-]+$/;
const CONFIG_COMMENT = /^\s*(?:#|;|\/\/)/;
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/**
 * Model defaults found anywhere in the repo, by lower-cased variable / env / config key name
 * (`default_model`, `openai_model`), pointing at where they are set.
 */
export type RepoDefaults = ReadonlyMap<string, string>;

const DEFAULT_ASSIGN =
  /^[ \t]*(?:export\s+)?(?:(?:const|let|var|readonly|static|private|public)\s+)*(?:self\.|this\.)?["']?([A-Za-z_$][\w$]*)["']?\s*(?::[^=\n]*)?[=:][^\n]*?["']?((?:openai\/)?gpt-4[\w.-]*)["']?/gm;

/** Names too common to link across files unless they are a class field (`model: str = "gpt-4o"`). */
const GENERIC_NAMES = new Set(["model", "model_name", "modelname", "model_id", "modelid", "llm_model"]);
const CLASS_FIELD = /^[ \t]+([A-Za-z_]\w*)\s*:\s*[A-Za-z_][\w.[\], |]*=\s*(?:Field\(\s*(?:default\s*=\s*)?)?["']((?:openai\/)?gpt-4[\w.-]*)["']\s*\)?\s*(?:#[^\n]*)?$/gm;

/** Records `<name with "model"> = "gpt-4o-mini"`-style defaults in one file, for `RepoDefaults`. */
export function collectDefaults(file: string, text: string, into: Map<string, string>): void {
  const kind = fileKind(file);
  if (kind === "skip") return;
  const record = (key: string, name: string, id: string, at: number) => {
    if (!into.has(key)) into.set(key, `${file}:${lineOf(text, at)} sets ${name} to ${id}`);
  };
  for (const m of text.matchAll(DEFAULT_ASSIGN)) {
    const name = m[1]!;
    const key = name.toLowerCase();
    if (!/model/i.test(name) || GENERIC_NAMES.has(key) || classify(m[2]!) !== "swap") continue;
    record(key, name, m[2]!, m.index);
  }
  if (kind !== "py") return;
  for (const m of text.matchAll(CLASS_FIELD)) {
    const name = m[1]!;
    if (/model/i.test(name) && classify(m[2]!) === "swap") record(`.${name.toLowerCase()}`, name, m[2]!, m.index);
  }
}

export function scanOpenAI(file: string, text: string, defaults: RepoDefaults = new Map()): OpenAIScan {
  const kind = fileKind(file);
  const out: OpenAIScan = { findings: [], edits: [] };
  if (kind === "skip") return out;

  if (kind === "py" || kind === "js") {
    const src = lex(text, kind);
    for (const literal of src.strings) {
      if (literal.block || !isSetting(text, literal.start, literal.end, literal.value) || inPrefixList(src, literal.start)) {
        continue;
      }
      collectIds(file, text, literal.start + literal.quote.length, literal.value, out,
        literalBlocker(src, literal.start, literal.end));
    }
    analyzeCallSites(file, src, out, defaults);
  } else {
    const json = extname(file).toLowerCase() === ".json";
    let offset = 0;
    for (const line of text.split("\n")) {
      if (!CONFIG_COMMENT.test(line)) {
        if (kind === "config" && !json) {
          const value = /[:=](.*)$/.exec(line)?.[1] ?? line;
          if (!PROSE.test(value.replace(/["']/g, ""))) {
            const first = [...line.matchAll(TOKEN)].find((m) => classify(m[0].replace(/[.:]+$/, "")) !== null);
            collectIds(file, text, offset, line, out, first ? lineBlocker(line, first[0].replace(/[.:]+$/, "")) : null);
          }
        } else {
          for (const m of line.matchAll(QUOTED)) {
            const start = offset + m.index;
            if (!isSetting(text, start, start + m[0].length, m[2]!)) continue;
            const key = /^\s*:/.test(line.slice(m.index + m[0].length)) ? "key" : null;
            // `{"model": "gpt-4o", "fallbacks": ["gpt-4o-mini"]}` on one line: swapping both makes them equal.
            collectIds(file, text, start + 1, m[2]!, out, key ?? bracketBlocker(line, m.index) ?? valuesBlocker(line));
          }
        }
      }
      offset += line.length + 1;
    }
  }
  return dropIgnored(text, out);
}

/** Matching code tests a model name (`startswith("gpt-4o")`, `"gpt-4o" in name`); it doesn't send one. */
const MATCHER_BEFORE =
  /(?:\.(?:startswith|endswith|startsWith|endsWith|includes|indexOf|match|search)|\b(?:encoding_for_model|encodingForModel|fnmatch|re\.(?:match|search)))\s*\(\s*\(?\s*(?:(["'])[^"'\n]*\1\s*,\s*)*$|tiktoken_model_name\s*=\s*$/;
const MATCHER_AFTER = /^\s*(?:(?:,\s*["'][^"'\n]*["']\s*)*\)\s*)?(?:not\s+in|in)\s/;

/** Whether the string literal [start, end) reads as a model setting rather than prose or a name test. */
function isSetting(text: string, start: number, end: number, value: string): boolean {
  if (PROSE.test(value)) return false;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (MATCHER_BEFORE.test(text.slice(lineStart, start))) return false;
  const lineEnd = text.indexOf("\n", end);
  return !MATCHER_AFTER.test(text.slice(end, lineEnd === -1 ? text.length : lineEnd));
}

const IGNORE = "llm-retire-scan: ignore";

/** Drops findings and edits on a line that carries, or follows a line that carries, the ignore comment. */
function dropIgnored(text: string, out: OpenAIScan): OpenAIScan {
  const lines = text.split("\n");
  const commentOnly = (text = "") => /^\s*(?:#|\/\/|\/\*|\*|<!--)/.test(text) && text.includes(IGNORE);
  const ignored = (line: number) => lines[line - 1]?.includes(IGNORE) || commentOnly(lines[line - 2]);
  const findings = out.findings.filter((f) => !ignored(f.line)).sort((a, b) => a.line - b.line);
  if (!text.includes(IGNORE)) return { findings, edits: out.edits };
  return { findings, edits: out.edits.filter((e) => !ignored(lineOf(text, e.start))) };
}

type FixBlocker = "key" | "list" | null;

const BLOCKER_NOTE: Record<"key" | "list", string> = {
  key: " It is a key (a price or limit table?): add a gpt-6-luna entry by hand; --fix leaves it.",
  list: " It sits in a list of several models: --fix leaves it so the list doesn't end up with duplicates.",
};

/** Whether swapping the literal [start, end) would break a table: a dict key or one of several IDs in a list. */
function literalBlocker(src: Source, start: number, end: number): FixBlocker {
  const open = enclosingOpen(src, start);
  if (open === -1) return null;
  const before = src.text.slice(open + 1, start).trimEnd();
  if (src.text[open] === "{" && /^\s*:/.test(src.text.slice(end)) && (before === "" || before.endsWith(","))) return "key";
  if (src.text[open] !== "[" && src.text[open] !== "(") return null;
  if (/[\w$.]\s*$/.test(src.text.slice(Math.max(0, open - 1), open))) return null; // a call, not a tuple
  const close = matchingClose(src, open);
  const siblings = src.strings.filter((x) => x.start > open && x.start < close && classify(x.value) !== null);
  return siblings.length >= 2 ? "list" : null;
}

/** A tuple/list like `("gpt-", "o1", "o3")` holds name prefixes for matching, not models to call. */
function inPrefixList(src: Source, start: number): boolean {
  const open = enclosingOpen(src, start);
  if (open === -1 || (src.text[open] !== "(" && src.text[open] !== "[")) return false;
  const close = matchingClose(src, open);
  return src.strings.some((x) => x.start > open && x.start < close && /^[a-z][\w.]*-$/.test(x.value));
}

/** The same check for a config line: a YAML/TOML key, or a line that lists several models. */
function lineBlocker(line: string, raw: string): FixBlocker {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (new RegExp(`^\\s*["']?${escaped}["']?\\s*[:=]`).test(line)) return "key";
  const ids = [...line.matchAll(TOKEN)].filter((m) => classify(m[0].replace(/[.:]+$/, "")) !== null);
  return ids.length >= 2 ? "list" : null;
}

/** "list" when one JSON line holds several model IDs as values (not keys): `"model": ..., "fallbacks": [...]`. */
function valuesBlocker(line: string): FixBlocker {
  const values = [...line.matchAll(QUOTED)].filter((m) =>
    !/^\s*:/.test(line.slice(m.index + m[0].length)) &&
    [...m[2]!.matchAll(TOKEN)].some((t) => classify(t[0].replace(/[.:]+$/, "")) !== null));
  return values.length >= 2 ? "list" : null;
}

/** For a quoted string at `at` in a one-line array (`["gpt-4o", "gpt-4.1"]`): "list" when it names several models. */
function bracketBlocker(line: string, at: number): FixBlocker {
  const open = line.lastIndexOf("[", at);
  if (open === -1 || line.lastIndexOf("]", at) > open) return null;
  const close = line.indexOf("]", at);
  return lineBlocker(line.slice(open, close === -1 ? line.length : close), "\u0000");
}

function collectIds(
  file: string, text: string, offset: number, chunk: string, out: OpenAIScan, blocker: FixBlocker = null,
): void {
  for (const match of chunk.matchAll(TOKEN)) {
    const raw = match[0].replace(/[.:]+$/, "");
    const parsed = parseModelId(raw);
    if (!parsed) continue;
    const notice = noticeFor(parsed.base)!;
    const at = offset + match.index;
    const line = lineOf(text, at);
    const finding = (rule: string, message: string, fixable = false): Finding => ({
      file, line, provider: "openai", rule, severity: "error", message, fixable,
    });

    if (parsed.fineTune) {
      out.findings.push(finding("fine-tune",
        `${raw} is a fine-tune of ${parsed.base}; it stops with its base model on ${notice.date}. ` +
        `${notice.replacement} has no fine-tuning endpoint, so there is no drop-in ID to swap in.`));
    } else if (notice.group === "text") {
      const lineBlock = blocker;
      out.findings.push(finding("shutdown",
        `${raw} shuts down on ${notice.date}. Replacement: ${notice.replacement}, a reasoning model ` +
        `(default reasoning effort: medium).${lineBlock ? BLOCKER_NOTE[lineBlock] : ""}`, !lineBlock));
      if (!lineBlock) {
        const start = at + parsed.prefix.length;
        out.edits.push({ start, end: start + parsed.base.length, text: LUNA });
      }
    } else if (notice.group === "audio") {
      out.findings.push(finding("audio-shutdown",
        `${raw} shuts down on ${notice.date} (its own notice, not the GPT-4o text one). Replacement: ${notice.replacement}.`));
    } else {
      out.findings.push(finding("retired", `${raw} was shut down on ${notice.date}. Replacement: ${notice.replacement}.`));
    }
  }
}

type Via = "sdk" | "langchain" | "litellm" | "raw";
type Api = "chat" | "responses";
type ModelState = "swap" | "gpt6-none" | "gpt6-responses" | "maybe";

interface Resolved {
  state: ModelState;
  /** Why a "maybe" model is suspected. */
  note?: string;
}

const ENV_NAME = /(?:getenv|environ\.get|environ\[|process\.env\.|process\.env\[|env\()\s*\(?\s*["']?([A-Za-z_][A-Za-z0-9_]*)/;

interface CallSite {
  at: number;
  via: Via;
  api: Api;
  group: Entry[];
  open: number;
  /** Keys added to a spread options dict after it was built (`args["tools"] = ...`). */
  extraKeys: Set<string>;
}

const MODEL_KEYS = new Set(["model", "model_name", "modelName"]);
const TOOL_KEYS = new Set(["tools", "functions", "tool_choice", "toolChoice", "function_call"]);
const SAMPLING_KEYS = new Set(["temperature", "top_p", "topP", "logprobs", "top_logprobs", "topLogprobs"]);
const EFFORT_KEYS = new Set(["reasoning_effort", "reasoningEffort", "reasoning"]);
const LANGCHAIN_TOOLS =
  /\.bind_tools\s*\(|\bbindTools\s*\(|\bcreate_react_agent\b|\bcreateReactAgent\b|\bcreate_tool_calling_agent\b|\bcreateToolCallingAgent\b|\bcreate_openai_(?:tools|functions)_agent\b|\bAgentExecutor\b/;

const CALLS: { re: RegExp; via: Via; api: Api }[] = [
  { re: /\.chat\.completions\.(?:create|parse|stream)\s*\(/g, via: "sdk", api: "chat" },
  { re: /\.responses\.(?:create|parse|stream)\s*\(/g, via: "sdk", api: "responses" },
  { re: /\bChatOpenAI\s*\(/g, via: "langchain", api: "chat" },
  { re: /\blitellm\.a?completion\s*\(/g, via: "litellm", api: "chat" },
];
const LITELLM_IMPORT = /from\s+litellm\s+import\s+[^\n]*\ba?completion\b/;
const BARE_COMPLETION = /(?<![\w.])a?completion\s*\(/g;
const RAW_ENDPOINT = /\/(?:v1\/)?(chat\/completions|responses)(?![\w/])/;

function findCallSites(src: Source): CallSite[] {
  const sites: CallSite[] = [];
  const addSite = (at: number, open: number, via: Via, api: Api) => {
    if (sites.some((s) => s.open === open)) return;
    const close = matchingClose(src, open);
    if (close === -1) return;
    const group = findParamGroup(src, open, close, 0);
    if (group) {
      sites.push({ at, via, api, group: group.entries, open: group.open, extraKeys: new Set() });
      return;
    }
    // `create(**create_params)`: the options dict built just before the call holds the model.
    for (const spread of spreadsIn(src, open, close, 0)) {
      const dict = spreadDict(src, spreadName(src, spread), at);
      if (dict?.entries.some((e) => e.key && MODEL_KEYS.has(e.key))) {
        sites.push({ at, via, api, group: dict.entries, open: dict.open, extraKeys: dict.extraKeys });
        return;
      }
    }
  };

  const patterns = [...CALLS];
  if (src.language === "py" && LITELLM_IMPORT.test(src.text)) {
    patterns.push({ re: BARE_COMPLETION, via: "litellm", api: "chat" });
  }
  for (const { re, via, api } of patterns) {
    for (const m of src.text.matchAll(re)) {
      if (src.mask[m.index] !== CODE) continue;
      addSite(m.index, m.index + m[0].length - 1, via, api);
    }
  }

  // Raw HTTP: fetch(".../v1/chat/completions", {...}), requests.post(url, json={...}), axios.post(...).
  for (const literal of src.strings) {
    const endpoint = RAW_ENDPOINT.exec(literal.value);
    if (!endpoint) continue;
    const open = enclosingOpen(src, literal.start);
    if (open === -1 || src.text[open] !== "(") continue;
    addSite(literal.start, open, "raw", endpoint[1] === "responses" ? "responses" : "chat");
  }
  return sites;
}

/** The bracket group (call arguments or an object literal inside them) that holds the `model` key. */
function findParamGroup(src: Source, open: number, close: number, depth: number):
  { open: number; entries: Entry[] } | null {
  const list = entries(src, open, close);
  if (list.some((e) => e.key && MODEL_KEYS.has(e.key))) return { open, entries: list };
  if (depth >= 3) return null;
  for (const entry of list) {
    for (let i = entry.valueStart; i < entry.end; i += 1) {
      const ch = src.text[i]!;
      if (src.mask[i] !== CODE || !"({[".includes(ch)) continue;
      const inner = matchingClose(src, i);
      if (inner === -1) break;
      const found = findParamGroup(src, i, inner, depth + 1);
      if (found) return found;
      i = inner;
    }
  }
  return null;
}

function valueText(src: Source, entry: Entry): string {
  return src.text.slice(entry.valueStart, entry.end);
}

/** Model IDs in string literals inside [from, to). */
function idsIn(src: Source, from: number, to: number): string[] {
  return src.strings.filter((s) => s.start >= from && s.start < to && !s.block).map((s) => s.value);
}

function classify(id: string): ModelState | null {
  const parsed = parseModelId(id);
  if (parsed && !parsed.fineTune && noticeFor(parsed.base)?.group === "text") return "swap";
  const bare = id.replace(/^(?:openrouter\/)?openai\//, "");
  if (NEEDS_NONE_FOR_CHAT_TOOLS.has(bare)) return "gpt6-none";
  if (RESPONSES_ONLY_TOOLS.has(bare)) return "gpt6-responses";
  return null;
}

function resolveModel(src: Source, entry: Entry, fileHasSwapId: boolean, defaults: RepoDefaults): Resolved | null {
  const state = resolveInFile(src, entry);
  if (state) return { state };
  if (state === null) return null;
  const value = entry.style === "shorthand" ? entry.key! : valueText(src, entry);
  const last = /(\.?)([A-Za-z_$][\w$]*)\s*\)?\s*$/.exec(value);
  const keys = [ENV_NAME.exec(value)?.[1]?.toLowerCase(), last?.[2]?.toLowerCase()];
  if (last?.[1]) keys.push(`.${last[2]!.toLowerCase()}`); // `agent.model` → a class field named model
  for (const key of keys) {
    const origin = key ? defaults.get(key) : undefined;
    if (origin) return { state: "maybe", note: ` The model may come from there: ${origin}.` };
  }
  return fileHasSwapId ? { state: "maybe", note: " The model comes from a variable; this file also names a retiring ID." } : null;
}

/** The model's state from this file alone; null = some other model, undefined = can't tell. */
function resolveInFile(src: Source, entry: Entry): Exclude<ModelState, "maybe"> | null | undefined {
  const literals = idsIn(src, entry.valueStart, entry.end);
  for (const id of literals) {
    const state = classify(id);
    if (state && state !== "maybe") return state;
  }
  // A literal that names some other model (`model="gpt-5.6-sol"`, `os.getenv("M", "o3")`): not ours.
  if (literals.some((value) => MODEL_LIKE.test(value) && !/^[A-Z_][A-Z0-9_]*$/.test(value))) return null;
  // `model=MODEL` / `model: config.model` / `{ model }`: find where that name is assigned in this file
  // (statement level or an object/class body, never another call's keyword argument).
  const name = /([A-Za-z_$][\w$]*)\s*$/.exec(entry.style === "shorthand" ? entry.key! : valueText(src, entry))?.[1];
  if (name) {
    const escaped = name.replace(/\$/g, "\\$");
    const assign = new RegExp(`^[ \\t]*(?:export\\s+)?(?:(?:const|let|var|readonly|private|public|static)\\s+)*(?:self\\.|this\\.)?${escaped}\\s*(?::[^=\\n]*)?=(?!=)[^\\n]*|^[ \\t]*["']?${escaped}["']?\\s*:[^\\n]*`, "gm");
    for (const m of src.text.matchAll(assign)) {
      const at = m.index + m[0].search(/\S/);
      if (src.mask[at] !== CODE && !src.strings.some((s) => s.start === at)) continue;
      const open = enclosingOpen(src, at);
      if (open !== -1 && src.text[open] !== "{") continue;
      const ids = idsIn(src, m.index, m.index + m[0].length);
      for (const id of ids) {
        const state = classify(id);
        if (state && state !== "maybe") return state;
      }
      if (ids.some((id) => /^[a-z][\w./:-]*-[\w.]+$/.test(id))) return null; // set to some other model
    }
    // A parameter default: `def __init__(self, model="gpt-4o-mini")`, `constructor(model = "gpt-4o")`.
    const param = new RegExp(`\\b${escaped}\\s*(?::[^=,)\\n]*)?=\\s*(["'])([^"'\\n]+)\\1`, "g");
    for (const m of src.text.matchAll(param)) {
      if (src.mask[m.index] !== CODE) continue;
      const open = enclosingOpen(src, m.index);
      if (open === -1 || src.text[open] !== "(") continue;
      if (!/(?:\bdef\s+\w+|\bfunction\s*\w*|\bconstructor)\s*$/.test(src.text.slice(Math.max(0, open - 60), open))) continue;
      const state = classify(m[2]!);
      if (state && state !== "maybe") return state;
    }
  }
  return undefined;
}

/** Spread entries (`**opts`, `...opts`) in a call's arguments or in an object literal passed to it. */
function spreadsIn(src: Source, open: number, close: number, depth: number): Entry[] {
  const list = entries(src, open, close);
  const found = list.filter((e) => e.style === "spread");
  if (depth >= 1) return found;
  for (const entry of list) {
    if (entry.style !== "positional" || src.text[entry.start] !== "{") continue;
    const inner = matchingClose(src, entry.start);
    if (inner !== -1) found.push(...spreadsIn(src, entry.start, inner, depth + 1));
  }
  return found;
}

function spreadName(src: Source, spread: Entry): string {
  return valueText(src, spread).replace(/^(?:\*\*|\.\.\.)/, "").trim();
}

interface SpreadDict {
  open: number;
  entries: Entry[];
  extraKeys: Set<string>;
}

/**
 * The last `NAME = {...}` (Python dict or JS object) before `before`, plus the keys set on it
 * between there and `before` (`NAME["tools"] = ...`, `NAME.tools = ...`).
 */
function spreadDict(src: Source, name: string, before: number): SpreadDict | null {
  if (!/^[A-Za-z_$][\w$.]*$/.test(name)) return null;
  const bare = name.split(".").pop()!.replace(/\$/g, "\\$");
  const assign = new RegExp(`^[ \\t]*(?:export\\s+)?(?:(?:const|let|var)\\s+)?(?:self\\.|this\\.)?${bare}\\s*(?::[^=\\n]*)?=\\s*\\{`, "gm");
  let found: SpreadDict | null = null;
  for (const m of src.text.matchAll(assign)) {
    const open = m.index + m[0].length - 1;
    if (open >= before) break;
    if (src.mask[open] !== CODE) continue;
    const close = matchingClose(src, open);
    if (close === -1 || close > before) continue;
    found = { open, entries: entries(src, open, close), extraKeys: new Set() };
  }
  if (!found) return null;
  const later = new RegExp(`(?<![\\w$.])${bare}\\s*(?:\\[\\s*["']([\\w$]+)["']\\s*\\]|\\.([A-Za-z_$][\\w$]*))\\s*=(?!=)`, "g");
  for (const m of src.text.slice(found.open, before).matchAll(later)) {
    if (src.mask[found.open + m.index] === CODE) found.extraKeys.add((m[1] ?? m[2])!);
  }
  return found;
}

const EDIT_VIAS = new Set<string>(["sdk:py", "sdk:js", "raw:py", "raw:js", "litellm:py", "langchain:py"]);

function analyzeCallSites(file: string, src: Source, out: OpenAIScan, defaults: RepoDefaults): void {
  const sites = findCallSites(src);
  if (sites.length === 0) return;
  const fileHasSwapId = src.strings.some((s) =>
    !s.block && isSetting(src.text, s.start, s.end, s.value) &&
    [...s.value.matchAll(TOKEN)].some((m) => classify(m[0]) === "swap"));
  const instructorToolMode = /\b(?:instructor\.)?(?:from_openai|patch)\s*\(/.test(src.text) &&
    /\bimport\s+instructor\b|\bfrom\s+instructor\b/.test(src.text) &&
    !/Mode\.(?!TOOLS\b|PARALLEL_TOOLS\b|TOOLS_STRICT\b)[A-Z_]+/.test(src.text);
  const langchainTools = [...src.text.matchAll(new RegExp(LANGCHAIN_TOOLS, "g"))]
    .some((m) => src.mask[m.index] === CODE);

  for (const site of sites) {
    const modelEntry = site.group.find((e) => e.key && MODEL_KEYS.has(e.key))!;
    const resolved = resolveModel(src, modelEntry, fileHasSwapId, defaults);
    if (!resolved) continue;
    const { state } = resolved;

    const byKey = new Map(site.group.filter((e) => e.key).map((e) => [e.key!, e]));
    // `**OPTIONS` / `...OPTIONS`: read the keys of that dict / object literal when this file defines it.
    const extraKeys = new Set(site.extraKeys);
    for (const spread of site.group.filter((e) => e.style === "spread")) {
      const dict = spreadDict(src, spreadName(src, spread), site.at);
      for (const entry of dict?.entries ?? []) {
        if (entry.key && !byKey.has(entry.key)) byKey.set(entry.key, entry);
      }
      for (const key of dict?.extraKeys ?? []) extraKeys.add(key);
    }
    const has = (key: string) => byKey.has(key) || extraKeys.has(key);
    // `**opts` built somewhere this file doesn't show: it may carry tools or sampling settings.
    const unseenSpread = site.group.some((e) => e.style === "spread" && !spreadDict(src, spreadName(src, e), site.at));
    let api = site.api;
    const responsesFlag = byKey.get("use_responses_api") ?? byKey.get("useResponsesApi");
    if (site.via === "langchain" && responsesFlag && /true/i.test(valueText(src, responsesFlag))) api = "responses";

    // instructor's default Mode.TOOLS turns `response_model=` into a forced tool call.
    const instructorTools = instructorToolMode && has("response_model");
    const hasTools = [...TOOL_KEYS].some(has) || (site.via === "langchain" && langchainTools) ||
      instructorTools;
    const sampling = [...SAMPLING_KEYS].filter(has);
    const effortEntry = [...EFFORT_KEYS].map((k) => byKey.get(k)).find(Boolean);
    const effortNone = effortEntry !== undefined && /["']none["']/.test(valueText(src, effortEntry));
    const maxTokens = byKey.get("max_tokens");

    const line = lineOf(src.text, site.at);
    const target = state === "swap" || state === "maybe" ? LUNA : "this GPT-6 model";
    const canEdit = (state === "swap" || state === "gpt6-none") && !effortEntry && !unseenSpread &&
      EDIT_VIAS.has(`${site.via}:${src.language}`);
    const push = (rule: string, severity: Severity, message: string, fixable: boolean) => {
      const where = resolved.note ?? "";
      out.findings.push({
        file, line, provider: "openai", rule, severity: state === "maybe" ? "warn" : severity,
        message: message + where, fixable,
      });
    };
    const label = `${viaLabel(site.via)} ${api === "chat" ? "Chat Completions" : "Responses"} call`;
    let wantNone = false;

    if (state === "gpt6-responses" && hasTools && api === "chat") {
      push("tools-responses-only", "error",
        `${label} sends tools to a model that takes tool calls only on the Responses API.`, false);
    }
    if (state !== "gpt6-responses" && hasTools && api === "chat" && !effortNone) {
      push("tools-effort", "error",
        `${label} sends tools${instructorTools ? " (instructor Mode.TOOLS turns response_model into one)" : ""}. On ${target}, Chat Completions supports function calling only with ` +
        `reasoning_effort "none"` + (effortEntry ? "; this call sets another effort (use none, or move to Responses)." :
          "; the default is medium. Set it to none, or move this call to the Responses API to keep reasoning."),
        canEdit);
      wantNone = true;
    }
    if (sampling.length > 0 && !effortNone) {
      push("sampling-effort", "error",
        `${label} sets ${sampling.join(", ")}. On ${target}, temperature, top_p and top_logprobs (and logprobs on ` +
        `Chat Completions) are rejected unless reasoning effort is "none"` +
        (state === "gpt6-responses" ? " (which some GPT-6 models don't support: remove them)." : "."),
        canEdit);
      wantNone = wantNone || state !== "gpt6-responses";
    }
    const renamable = (state === "swap" || state === "gpt6-none") && EDIT_VIAS.has(`${site.via}:${src.language}`);
    if (maxTokens && api === "chat" && (site.via === "sdk" || site.via === "raw") && state !== "maybe") {
      push("max-tokens", "warn",
        `${label} sets max_tokens, deprecated in favour of max_completion_tokens; on a reasoning model the limit ` +
        "also has to cover reasoning tokens.", renamable);
      if (renamable && maxTokens.keyStart !== undefined) {
        out.edits.push({ start: maxTokens.keyStart, end: maxTokens.keyStart + "max_tokens".length, text: "max_completion_tokens" });
      }
    }
    const toolsFlagged = hasTools && api === "chat";
    if ((state === "swap" || state === "gpt6-none") && !toolsFlagged && sampling.length === 0 && !effortEntry) {
      push("default-effort", "warn",
        `${label}: ${state === "swap" ? "after the swap it runs" : "it runs"} at the default medium reasoning effort ` +
        `(slower, and reasoning tokens are billed as output). Set the effort explicitly; "none" skips reasoning.`, false);
    }

    // Swapping the ID alone would leave a call that fails on the new model: keep the old ID for a human.
    const manual = wantNone && !canEdit;
    if (state === "swap" && (manual || unseenSpread)) {
      holdSwap(out, modelEntry, lineOf(src.text, modelEntry.valueStart), manual
        ? " --fix leaves this call: change its tools or sampling settings by hand first (see the call-site finding)."
        : " --fix leaves this call: it spreads options defined elsewhere, which may hold tools or temperature.");
    } else if (wantNone && canEdit) {
      out.edits.push(effortEdit(src, site, modelEntry, api));
    }
  }
}

/** Drops the ID-swap edits inside the call's model argument and marks its shutdown finding as not fixed. */
function holdSwap(out: OpenAIScan, model: Entry, line: number, note: string): void {
  const before = out.edits.length;
  out.edits = out.edits.filter((e) => !(e.start >= model.valueStart && e.end <= model.end && e.text === LUNA));
  if (out.edits.length === before) return;
  for (const f of out.findings) {
    if (f.line === line && f.rule === "shutdown" && f.fixable) {
      f.fixable = false;
      f.message += note;
    }
  }
}

function effortEdit(src: Source, site: CallSite, model: Entry, api: Api): Edit {
  const quote = src.strings.find((s) => s.start >= model.valueStart && s.start < model.end)?.quote ?? '"';
  const q = quote.length === 1 && quote !== "`" ? quote : '"';
  let param: string;
  if (model.style === "kwarg") {
    param = api === "chat" ? `reasoning_effort=${q}none${q}` : `reasoning={${q}effort${q}: ${q}none${q}}`;
  } else if (model.style === "quoted") {
    const k = model.keyQuote!;
    param = api === "chat" ? `${k}reasoning_effort${k}: ${k}none${k}` : `${k}reasoning${k}: {${k}effort${k}: ${k}none${k}}`;
  } else {
    param = api === "chat" ? `reasoning_effort: ${q}none${q}` : `reasoning: { effort: ${q}none${q} }`;
  }
  const multiline = src.text.slice(site.open + 1, model.start).includes("\n");
  const text = multiline ? `,\n${indentOf(src.text, model.start)}${param}` : `, ${param}`;
  return { start: model.end, end: model.end, text };
}

function viaLabel(via: Via): string {
  return { sdk: "OpenAI SDK", langchain: "LangChain ChatOpenAI", litellm: "LiteLLM", raw: "HTTP" }[via];
}

