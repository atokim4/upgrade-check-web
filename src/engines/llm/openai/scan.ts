import { basename, extname } from "node:path";

import {
  type Entry, type Language, type Source, CODE, entries, indentOf, lex, lineOf, matchingClose, enclosingOpen,
} from "../source.ts";
import type { Edit, Finding, Severity } from "../types.ts";
import {
  type OpenAINotice, SOL_61, SOON_DAYS, TARGETS, type TargetRules, URGENT_DAYS, daysUntil, noticeFor, parseModelId,
  stripPrefix, todayUtc, whenText,
} from "./models.ts";

export interface OpenAIScan {
  findings: Finding[];
  edits: Edit[];
  /**
   * Defaults set in another file ("<file>:<line>") that a call here can't take as swapped: the directory scan
   * keeps --fix away from those lines.
   */
  holds: string[];
  /** Inserts that are valid only next to an ID swap: re-checked by `settle` whenever swaps are dropped. */
  links: Link[];
}

/**
 * An edit that only makes sense together with an ID swap inside `needs` (e.g. `reasoning_effort: "none"` for
 * gpt-6-luna). `pair`: an edit that must go with it (the pro-mode swap and its `reasoning.mode` insert).
 */
export interface Link {
  edit: Edit;
  needs: [number, number][];
  findings: Finding[];
  pair?: Edit;
}

const PY = new Set([".py"]);
const JS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]);
const OTHER_CODE = new Set([".go", ".rb", ".php", ".java", ".kt", ".cs", ".rs", ".swift", ".dart", ".ex", ".exs"]);
const CONFIG = new Set([".tfvars", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".json", ".properties", ".env"]);
/** Release notes and docs mention old models on purpose. */
const PROSE_FILE = /^(?:changelog|changes|history|news|releases?)(?:\.|$)/i;

type FileKind = Language | "code" | "config" | "skip";

export function fileKind(file: string): FileKind {
  const name = basename(file);
  if (PROSE_FILE.test(name)) return "skip";
  // `terraform.tfvars.example`, `config.yml.sample`: the template is read as the file it stands for.
  const template = /\.(?:example|sample|dist|template)$/i.test(name) && !/^\.env(?:\.|$)/.test(name);
  const ext = extname(template ? name.replace(/\.[^.]+$/, "") : name).toLowerCase();
  if (PY.has(ext)) return "py";
  if (JS.has(ext)) return "js";
  if (OTHER_CODE.has(ext)) return "code";
  if (CONFIG.has(ext) || /^\.env(?:\.|$)/.test(name)) return "config";
  return "skip";
}

/** Characters a model ID can be made of, including `openai/` prefixes and `ft:` fine-tune names. */
const TOKEN = /[A-Za-z0-9_.:/-]+/g;
/**
 * The string is a sentence (a log line, a help text), not a model setting: two words in a row, a word before a
 * quoted name (`Order 'o1' (pending)`), or a short o-series name between words (`use o3 here`).
 */
const PROSE = /[A-Za-z]{2,}["'.:;)]*[ \t]+["'(]*[A-Za-z]{2,}|[A-Za-z]{3,}[ \t]+["']|[A-Za-z]{2,}[ \t]+o\d[ \t]+[A-Za-z]{2,}/;
const MODEL_LIKE = /^[\w./:-]+$/;
const CONFIG_COMMENT = /^\s*(?:#|;|\/\/)/;
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/**
 * Model defaults found anywhere in the repo, by lower-cased variable / env / config key name
 * (`default_model`, `openai_model`), pointing at where they are set: one "<file>:<line> sets <name> to <id>" line per
 * definition.
 */
export type RepoDefaults = ReadonlyMap<string, string>;

const DEFAULT_ASSIGN =
  /^[ \t]*(?:export\s+)?(?:(?:const|let|var|readonly|static|private|public)\s+)*(?:self\.|this\.)?["']?([A-Za-z_$][\w$]*)["']?\s*(?::[^=\n]*)?[=:][^\n]*?["']?((?:openai\/)?(?:gpt-[45]|o3)[\w.-]*)["']?/gm;

/** Names too common to link across files unless they are a class field (`model: str = "gpt-4o"`). */
const GENERIC_NAMES = new Set(["model", "model_name", "modelname", "model_id", "modelid", "llm_model"]);
const CLASS_FIELD = /^[ \t]+([A-Za-z_]\w*)\s*:\s*[A-Za-z_][\w.[\], |]*=\s*(?:Field\(\s*(?:default\s*=\s*)?)?["']((?:openai\/)?(?:gpt-[45]|o3)[\w.-]*)["']\s*\)?\s*(?:#[^\n]*)?$/gm;

/** Records `<name with "model"> = "gpt-4o-mini"`-style defaults in one file, for `RepoDefaults`. */
export function collectDefaults(file: string, text: string, into: Map<string, string>): void {
  const kind = fileKind(file);
  if (kind === "skip") return;
  const record = (key: string, name: string, id: string, at: number) => {
    // Every definition counts: a call may import the one in another file, so all of them are held together.
    const where = `${file}:${lineOf(text, at)} sets ${name} to ${id}`;
    const known = into.get(key);
    if (!known?.split("\n").includes(where)) into.set(key, known ? `${known}\n${where}` : where);
  };
  for (const m of text.matchAll(DEFAULT_ASSIGN)) {
    const name = m[1]!;
    const key = name.toLowerCase();
    if (!/model/i.test(name) || GENERIC_NAMES.has(key) || !retiring(m[2]!)) continue;
    record(key, name, m[2]!, m.index);
  }
  if (kind !== "py") return;
  for (const m of text.matchAll(CLASS_FIELD)) {
    const name = m[1]!;
    if (/model/i.test(name) && retiring(m[2]!)) record(`.${name.toLowerCase()}`, name, m[2]!, m.index);
  }
}

/**
 * Scans one file. `today` (YYYY-MM-DD) sets how close each shutdown is: within 30 days (or past) is urgent,
 * more than 90 days out is a warning.
 */
export function scanOpenAI(
  file: string, text: string, defaults: RepoDefaults = new Map(), today: string = todayUtc(),
): OpenAIScan {
  const kind = fileKind(file);
  const out: OpenAIScan = { findings: [], edits: [], holds: [], links: [] };
  if (kind === "skip") return out;

  if (kind === "py" || kind === "js") {
    const src = lex(text, kind);
    for (const literal of src.strings) {
      if (literal.block || !isSetting(text, literal.start, literal.end, literal.value) || inPrefixList(src, literal.start)) {
        continue;
      }
      collectIds(file, text, literal.start + literal.quote.length, literal.value, out, today,
        literalBlocker(src, literal.start, literal.end, literal.value));
    }
    analyzeCallSites(file, src, out, defaults, today);
  } else {
    const json = extname(file).toLowerCase() === ".json";
    let offset = 0;
    for (const line of text.split("\n")) {
      if (!CONFIG_COMMENT.test(line)) {
        if (kind === "config" && !json) {
          const value = /[:=](.*)$/.exec(line)?.[1] ?? line;
          if (!PROSE.test(value.replace(/["']/g, ""))) {
            const first = [...line.matchAll(TOKEN)].find((m) => classify(m[0].replace(/[.:]+$/, "")) !== null);
            collectIds(file, text, offset, line, out, today, first ? lineBlocker(line, first[0].replace(/[.:]+$/, "")) : null);
          }
        } else {
          const values = [...line.matchAll(QUOTED)];
          // `[]string{"gpt", "o1", "o3"}`: keys (`"reasoning": {...}`) don't count as items.
          const items = values.filter((m) => !/^\s*:/.test(line.slice(m.index + m[0].length)));
          if (prefixValues(items.map((m) => m[2]!))) values.length = 0;
          for (const m of values) {
            const start = offset + m.index;
            if (!isSetting(text, start, start + m[0].length, m[2]!)) continue;
            const key = /^\s*:/.test(line.slice(m.index + m[0].length)) ? "key" : null;
            // `{"model": "gpt-4o", "fallbacks": ["gpt-4o-mini"]}` on one line: swapping both makes them equal.
            collectIds(file, text, start + 1, m[2]!, out, today,
              key ?? bracketBlocker(line, m.index) ?? valuesBlocker(line) ?? namedBlocker(line, m.index, m[2]!) ??
              catalogBlocker(line.slice(0, m.index), objectAround(text, start)));
          }
        }
      }
      offset += line.length + 1;
    }
  }
  const kept = dropIgnored(text, out);
  return { ...kept, edits: settle(text, kept.edits, kept.findings, kept.links) };
}

const isSwap = (e: Edit) => TARGETS.has(e.text);

/**
 * Final pass over a file's edits, run again after the directory scan drops held lines:
 * - several calls spreading one options dict insert the same setting: keep one; inserts that disagree
 *   (a chat call and a Responses call sharing the dict) drop everything on that dict;
 * - an insert whose ID swap didn't survive (held, ignored, vetoed) goes, and its findings are no longer fixable.
 */
export function settle(text: string, edits: readonly Edit[], findings: Finding[], links: readonly Link[]): Edit[] {
  let kept = [...edits];
  const seen = new Map<number, string>();
  const clash = new Set<number>();
  kept = kept.filter((e) => {
    if (e.start !== e.end) return true;
    const before = seen.get(e.start);
    if (before === undefined) {
      seen.set(e.start, e.text);
      return true;
    }
    if (before !== e.text) clash.add(e.start);
    return false;
  });
  for (const link of links) {
    if (!clash.has(link.edit.start)) continue;
    kept = kept.filter((e) => !(isSwap(e) && link.needs.some(([from, to]) => e.start >= from && e.end <= to)));
    markHeld(text, findings, link.needs,
      " --fix leaves it: calls on different APIs share these options and would need different settings.");
  }
  const same = (a: Edit, b: Edit) => a.start === b.start && a.end === b.end && a.text === b.text;
  for (const link of links) {
    if (kept.some((e) => isSwap(e) && link.needs.some(([from, to]) => e.start >= from && e.end <= to))) continue;
    kept = kept.filter((e) => !same(e, link.edit) && !(link.pair && same(e, link.pair)));
    for (const f of link.findings) {
      if (!f.fixable) continue;
      f.fixable = false;
      f.message += " --fix leaves it: the model ID this call uses stays as it is (see the shutdown finding).";
    }
  }
  return kept;
}

/** Marks the fixable shutdown findings on the lines of `spans` as held. */
function markHeld(text: string, findings: Finding[], spans: [number, number][], note: string): void {
  const lines = new Set(spans.flatMap(([from, to]) => [lineOf(text, from), lineOf(text, Math.max(from, to - 1))]));
  for (const f of findings) {
    if (f.fixable && f.rule === "shutdown" && lines.has(f.line)) {
      f.fixable = false;
      f.message += note;
    }
  }
}

/** Matching code tests a model name (`startswith("gpt-4o")`, `"gpt-4o" in name`); it doesn't send one. */
const MATCHER_BEFORE =
  /(?:\.(?:startswith|endswith|startsWith|endsWith|includes|indexOf|match|search)|\b(?:encoding_for_model|encodingForModel|fnmatch|re\.(?:match|search)))\s*\(\s*\(?\s*(?:(["'])[^"'\n]*\1\s*,\s*)*$|tiktoken_model_name\s*=\s*$/;
const MATCHER_AFTER = /^\s*(?:(?:(?:,\s*["'][^"'\n]*["']\s*)*\)\s*)?(?:not\s+in|in)\s|[!=]==?(?!>))/;
/**
 * Also name tests: a comparison (`model == "gpt-5"`, `=== "gpt-5" ||`), Go's `strings.HasPrefix(model, "gpt-5")`,
 * and keys that hold a family name to match on (`family: 'gpt-5'`, `prefix = "o3"`).
 */
const NAME_TEST_BEFORE =
  /(?:[!=]==?\s*|\bstrings\.(?:HasPrefix|HasSuffix|Contains|EqualFold|Index)\s*\([^"'`\n]*,\s*|\b(?:family|prefix|prefixes|pattern)["']?\s*[:=]\s*)$/;
/** A regex in a string (`r"^gpt-5\.1$"`, `"^gpt-5(?:-\d{4})?$"`): it matches names, so gpt-5 in it is not a model. */
const REGEX_LIKE = /\\[.dwsbDWS]|\(\?[:=!<]|^\^|[^\\]\$$/;
/** Code inside a string (`e.g., dspy.LM('openai/gpt-5', temperature=1.0)`): an example in a help text. */
const CODE_IN_STRING = /[A-Za-z_]\w*\(\s*["'][^"']*["']\s*,/;

/** Whether the string literal [start, end) reads as a model setting rather than prose or a name test. */
function isSetting(text: string, start: number, end: number, value: string): boolean {
  if (PROSE.test(value) || REGEX_LIKE.test(value) || CODE_IN_STRING.test(value)) return false;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(lineStart, start);
  if (MATCHER_BEFORE.test(before) || NAME_TEST_BEFORE.test(before)) return false;
  const lineEnd = text.indexOf("\n", end);
  return !MATCHER_AFTER.test(text.slice(end, lineEnd === -1 ? text.length : lineEnd));
}

const IGNORE = "llm-retire-scan: ignore";

/** Drops findings and edits on a line that carries, or follows a line that carries, the ignore comment. */
/** Whether 1-based `line` carries, or follows a comment line that carries, the ignore comment. */
function ignoredLine(lines: readonly string[], line: number): boolean {
  const above = lines[line - 2] ?? "";
  return Boolean(lines[line - 1]?.includes(IGNORE)) ||
    (/^\s*(?:#|\/\/|\/\*|\*|<!--)/.test(above) && above.includes(IGNORE));
}

function dropIgnored(text: string, out: OpenAIScan): OpenAIScan {
  const lines = text.split("\n");
  const ignored = (line: number) => ignoredLine(lines, line);
  const findings = out.findings.filter((f) => !ignored(f.line)).sort((a, b) => a.line - b.line);
  if (!text.includes(IGNORE)) return { ...out, findings };
  return { ...out, findings, edits: out.edits.filter((e) => !ignored(lineOf(text, e.start))) };
}

type FixBlocker = "key" | "list" | "catalog" | "named" | null;

const BLOCKER_NOTE: Record<Exclude<FixBlocker, null>, string> = {
  catalog: " It is an entry in a model catalog or price table, not a request: mark it deprecated or remove it after " +
    "the shutdown and add the replacement as its own entry (its prices and limits differ); --fix leaves it.",
  named: " The constant is named after this model: swapping only the value would make the name lie. Add a constant " +
    "for the replacement and move the callers to it; --fix leaves it.",
  key: " It is a key (a price or limit table?): add an entry for the replacement by hand; --fix leaves it.",
  list: " It sits in a list of several models: --fix leaves it so the list doesn't end up with duplicates.",
};

/** Whether swapping the literal [start, end) would break a table: a dict key or one of several IDs in a list. */
function literalBlocker(src: Source, start: number, end: number, value: string): FixBlocker {
  const lineStart = src.text.lastIndexOf("\n", start - 1) + 1;
  const named = namedBlocker(src.text.slice(lineStart, end), start - lineStart, value);
  if (named) return named;
  const open = openAt(src, start);
  if (open === -1) return null;
  // Comments between entries don't count; a TS type map separates its members by newlines alone.
  const before = src.text.slice(open + 1, start).replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(src.language === "py" ? /#[^\n]*$/gm : /\/\/[^\n]*$/gm, "").trimEnd();
  // Not after `?` / `:` / operators: `{ model: fast ? "gpt-5-mini" : "gpt-5" }` is a value.
  if (src.text[open] === "{" && /^\s*:/.test(src.text.slice(end)) && !/[?:=&|+(-]$/.test(before)) return "key";
  const catalog = catalogGroup(src, open, start);
  if (catalog) return catalog;
  if (src.text[open] === "{" && src.language === "py") {
    // A Python set (`{"o1", "o3", "gpt-5"}`): no key/value colons at its top level. (In JS a `{` without colons
    // is a block.)
    const close = matchingClose(src, open);
    const body = src.text.slice(open + 1, close);
    if (close === -1 || body.includes(":")) return null;
    return stringsIn(src, open, close).filter((x) => classify(x.value) !== null).length >= 2 ? "list" : null;
  }
  if (src.text[open] !== "[" && src.text[open] !== "(") return null;
  const close = matchingClose(src, open);
  const siblings = stringsIn(src, open, close).filter((x) => classify(x.value) !== null);
  if (/[\w$.\])]\s*$/.test(src.text.slice(Math.max(0, open - 1), open))) {
    if (src.text[open] === "(") return null; // a call, not a tuple
    // `Literal["gpt-5", "o3"]` is a list of names; `MODELS["gpt-5"]` looks up a key that stays as it is.
    return siblings.length >= 2 ? "list" : "key";
  }
  return siblings.length >= 2 ? "list" : null;
}

/** A tuple/list like `("gpt-", "o1", "o3")` holds name prefixes for matching, not models to call. */
function inPrefixList(src: Source, start: number): boolean {
  const open = openAt(src, start);
  if (open === -1 || (src.text[open] !== "(" && src.text[open] !== "[")) return false;
  const close = matchingClose(src, open);
  return prefixValues(directValues(src, open, close).map((x) => x.value));
}

/** The string literals that are items of the group itself: not nested deeper, not keys (`"name": ...`). */
function directValues(src: Source, open: number, close: number): Source["strings"] {
  return stringsIn(src, open, close).filter((x) => openAt(src, x.start) === open && !/^\s*:/.test(src.text.slice(x.end, x.end + 40)));
}

const enclosingCache = new WeakMap<Source, Int32Array>();
/** `enclosingOpen` from the file's one-pass index (generated catalogs hold thousands of literals). */
function openAt(src: Source, at: number): number {
  let index = enclosingCache.get(src);
  if (!index) enclosingCache.set(src, index = enclosingIndex(src));
  return index[at]!;
}

/** The string literals that start inside (open, close), by binary search over the sorted `src.strings`. */
function stringsIn(src: Source, open: number, close: number): Source["strings"] {
  let lo = 0;
  let hi = src.strings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (src.strings[mid]!.start <= open) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < src.strings.length && src.strings[end]!.start < close) end += 1;
  return src.strings.slice(lo, end);
}

/** Bare family names that only make sense as prefixes to match on. */
const FAMILY_WORD = /^(?:gpt|chatgpt|o|claude|gemini|deepseek|[a-z][\w.]*-)$/;

/**
 * Items of one list that read as name prefixes: at least two items, one a family word or `gpt-`, or three bare
 * o-series names (o1, o3, o4).
 */
function prefixValues(values: readonly string[]): boolean {
  if (values.length < 2) return false;
  return values.some((v) => FAMILY_WORD.test(v)) || values.filter((v) => /^o\d$/.test(v)).length >= 3;
}

/** Keys that name a model inside a catalog entry (`{ id: "gpt-5", label: "GPT-5" }`). */
const CATALOG_ID_KEY = /\b(?:id|name|api_?name|apiName|model_name|slug)["']?\s*[:=]\s*$/;
/** Keys only a catalog or price entry has: a request never sends these next to its model. */
const CATALOG_KEYS =
  /["']?\b(?:label|display_?name|displayName|context_?window|contextWindow|context_?length|contextLength|pricing|\w*price\w*|\w*cost\w*|modalities|capabilities|deprecated|replacement|knowledge_?cutoff|owned_by|release_date|released|open_weights)\b["']?\s*[:=]/i;

/**
 * "catalog" for a model ID that is an entry in a catalog or price table: the value of `id` / `name` next to a
 * catalog-only key, or a positional argument next to bare numbers (`tokenPriced("openai", "gpt-5", 1.25, 10)`,
 * `Model("o3", 200000)`, `(("gpt-5-mini",), 0.25, 2.0)`).
 */
function catalogGroup(src: Source, open: number, start: number): FixBlocker {
  const lineStart = src.text.lastIndexOf("\n", start - 1) + 1;
  let group = open;
  for (let depth = 0; depth < 2 && group !== -1; depth += 1) {
    const facts = groupFacts(src, group);
    if (!facts) return null;
    if (depth === 0) {
      const before = src.text.slice(Math.max(lineStart, group + 1), start);
      if (CATALOG_ID_KEY.test(before) && facts.catalogKeys) return "catalog";
      // The ID is an item of its own (first, or after a comma), not the value of `model=` / `key:`.
      const lead = src.text.slice(Math.max(group + 1, start - 200), start);
      const positional = start - 200 <= group ? /(?:^|,)\s*$/.test(lead) : /,\s*$/.test(lead);
      // `Model("gpt-5", k(400), deprecated=True, replacement="...")`: a positional ID in a catalog record.
      if (src.text[group] === "(" && positional && facts.catalogKeys) return "catalog";
      // `tokenPriced("openai", "gpt-5", 1.25, 10)`: the ID is a positional item next to bare numbers.
      if (positional && facts.positionalNumber) return "catalog";
      // Only a tuple / list literal reaches one level up (`(("gpt-5-mini",), 0.25)`); a call's wrapper
      // (`wait_for(create(model="gpt-5"), 30)`) says nothing about the ID.
      if (!positional || isCall(src, group)) return null;
    } else if (facts.positionalNumber) {
      return "catalog";
    }
    group = openAt(src, group);
  }
  return null;
}

interface GroupFacts { catalogKeys: boolean; positionalNumber: boolean }
/** Per-file cache: a generated catalog has thousands of IDs in one array, so each group is read once. */
const groupCache = new WeakMap<Source, Map<number, GroupFacts | null>>();

function groupFacts(src: Source, open: number): GroupFacts | null {
  let cache = groupCache.get(src);
  if (!cache) groupCache.set(src, cache = new Map());
  if (cache.has(open)) return cache.get(open)!;
  const close = matchingClose(src, open);
  const facts = close === -1 ? null : {
    catalogKeys: CATALOG_KEYS.test(topLevelKeys(src, open, close)),
    positionalNumber: (src.text[open] === "(" || src.text[open] === "[") && positionalNumber(src, open, close),
  };
  cache.set(open, facts);
  return facts;
}

/** Whether `(` at `open` starts a call's arguments (`f(`, `x.y(`, `a[0](`) rather than a tuple. */
function isCall(src: Source, open: number): boolean {
  return src.text[open] === "(" && /[\w$\])]\s*$/.test(src.text.slice(Math.max(0, open - 40), open));
}

/**
 * The group's own top level as text, with everything nested and every string blanked out except string keys:
 * catalog keys are looked for there, so `default_headers={"X-Label": ...}` or a prompt saying "price:" don't count.
 */
function topLevelKeys(src: Source, open: number, close: number): string {
  const out: string[] = [];
  let depth = 0;
  for (let i = open + 1; i < close; i += 1) {
    if (src.mask[i] !== CODE) continue;
    const c = src.text[i]!;
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (depth === 0) out.push(c);
    else out.push(" ");
  }
  for (const x of stringsIn(src, open, close)) {
    if (openAt(src, x.start) === open && /^\s*:/.test(src.text.slice(x.end, x.end + 40))) out.push(` "${x.value}": `);
  }
  return out.join("");
}

/** Whether the group [open, close] has a bare number as one of its own top-level positional items. */
function positionalNumber(src: Source, open: number, close: number): boolean {
  let depth = 0;
  let item = open + 1;
  for (let i = open + 1; i <= close; i += 1) {
    const c = src.text[i]!;
    if (src.mask[i] !== CODE) continue;
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c) && i !== close) depth -= 1;
    if (depth === 0 && (c === "," || i === close)) {
      if (/^\s*-?\d[\d_]*(?:\.\d+)?\s*$/.test(src.text.slice(item, i))) return true;
      item = i + 1;
    }
  }
  return false;
}

/** "catalog" when the text before the ID ends in a catalog `id` / `name` key and its object has a catalog-only key. */
function catalogBlocker(before: string, object: string): FixBlocker {
  return CATALOG_ID_KEY.test(before) && CATALOG_KEYS.test(object) ? "catalog" : null;
}

/**
 * The text around `at` that a catalog entry would span, for JSON and other files without a bracket parser: from
 * the `{` before it to 25 lines after it (catalog entries nest their prices and limits in sub-objects).
 */
function objectAround(text: string, at: number): string {
  const open = text.lastIndexOf("{", at);
  if (open === -1) return "";
  let end = at;
  for (let i = 0; i < 25 && end !== -1; i += 1) end = text.indexOf("\n", end + 1);
  return text.slice(open, end === -1 ? text.length : end);
}

/** Lower-case letters and digits only: `GPT_5_MINI`, `gpt5_mini`, `ModelGPT5Mini` and `gpt-5-mini` meet here. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "named" for `GPT_5_MINI = "gpt-5-mini"`, `static let gpt5 = "gpt-5"`, `ModelGPT5Mini = "gpt-5-mini"`. */
function namedBlocker(line: string, at: number, value: string): FixBlocker {
  // The name right before `=` (an optional type in between has no commas: `def f(use_gpt5: bool, model=...)`).
  const m = /([A-Za-z_$][\w$]*)\s*(?::\s*[\w.[\]| ]*?)?\s*:?=\s*["'`]?$/.exec(line.slice(0, at + 1));
  const id = squash(value.replace(/^[\w-]+[/:]/, ""));
  if (!m || id.length < 3) return null;
  return squash(m[1]!).includes(id) ? "named" : null;
}

/** The same check for a config line: a YAML/TOML key, or a line that lists several models. */
function lineBlocker(line: string, raw: string): FixBlocker {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (new RegExp(`^\\s*["']?${escaped}["']?\\s*[:=]`).test(line)) return "key";
  if (/^\s*\[[^\]]*\]\s*$/.test(line)) return "key"; // a TOML table header: [models."gpt-5-mini"]
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
  file: string, text: string, offset: number, chunk: string, out: OpenAIScan, today: string,
  blocker: FixBlocker = null,
): void {
  for (const match of chunk.matchAll(TOKEN)) {
    const raw = match[0].replace(/[.:]+$/, "");
    // `gpt-5\.1` inside a pattern: the backslash escapes the next character of a longer name.
    if (chunk[match.index + match[0].length] === "\\") continue;
    const parsed = parseModelId(raw);
    if (!parsed) continue;
    const notice = noticeFor(parsed.base)!;
    const at = offset + match.index;
    if (SHORT_ID.test(parsed.base) && !parsed.prefix && !shortIdIsModel(text, at, chunk, raw)) continue;
    const days = daysUntil(notice.date, today);
    const urgent = days <= URGENT_DAYS;
    const when = notice.group === "retired"
      ? `was shut down on ${notice.date}`
      : `shuts down on ${notice.date} (${whenText(days)})`;
    const finding = (rule: string, message: string, fixable = false): Finding => ({
      file, line: lineOf(text, at), provider: "openai", rule, message, fixable, urgent,
      severity: notice.group !== "retired" && days > SOON_DAYS ? "warn" : "error",
    });

    if (parsed.fineTune) {
      out.findings.push(finding("fine-tune",
        `${raw} is a fine-tune of ${parsed.base}; it stops with its base model on ${notice.date}. ` +
        `${notice.replacement} has no fine-tuning endpoint, so there is no drop-in ID to swap in.`));
    } else if (notice.group === "text") {
      // `openai:gpt-5` is a pydantic-ai / LangChain model string: tools and settings are registered elsewhere
      // (`@agent.tool`, `model_settings`), out of this tool's sight, so the ID is never swapped there.
      const framework = parsed.prefix === "openai:"
        ? " It is a pydantic-ai / LangChain model string: tools and model settings are set elsewhere, so check them " +
          "against the replacement and swap it by hand; --fix leaves it."
        : "";
      const hold = blocker !== null || framework !== "";
      out.findings.push(finding("shutdown",
        `${raw} ${when}. Replacement: ${notice.replacement}, ${targetSummary(notice)}.` +
        `${blocker ? BLOCKER_NOTE[blocker] : ""}${framework}`, !hold));
      if (!hold) {
        const start = at + parsed.prefix.length;
        out.edits.push({ start, end: start + parsed.base.length, text: notice.replacement });
      }
    } else if (notice.group === "pro") {
      out.findings.push(finding("shutdown",
        `${raw} ${when}. Replacement: ${SOL_61} with reasoning.mode "pro", which OpenAI documents for the Responses ` +
        `API only. A plain ID swap would drop pro mode, so --fix changes it only inside a Responses call it can finish.`));
    } else if (notice.group === "image") {
      out.findings.push(finding("image-shutdown",
        `${raw} ${when}. Replacement: ${notice.replacement} (Sunburst for detailed work, Flare for fast iteration), ` +
        "on the Image API (images.generate / images.edit; their model pages list Responses as not supported). " +
        'Leaving out the new complexity setting means "high". Pick one by hand; --fix leaves image IDs.'));
    } else if (notice.group === "audio") {
      out.findings.push(finding("audio-shutdown",
        `${raw} ${when} (its own notice, not a text-model one). Replacement: ${notice.replacement}.`));
    } else {
      out.findings.push(finding("retired", `${raw} ${when}. Replacement: ${notice.replacement}.`));
    }
  }
}

/** Two-character o-series names (`o3`, `o1-pro`) are also chemistry, compiler levels and ID codes. */
const SHORT_ID = /^o\d(?:-pro|-mini)?$/;
const MODEL_CONTEXT = /model|llm|openai|deployment/i;
/** Words around a value that don't name it: `getenv("MODEL", "o3")`, `Field(default="o3")`, `const X = ...`. */
const NEUTRAL_WORDS = /^(?:default|value|fallback|get|getenv|environ|os|process|env|self|this|const|let|var|export|str|Field|field|Optional|return|or|and|await)$/;

/**
 * A short o-series name counts only as the value of a model setting: `MODEL = "o3"`, `model="o3"`,
 * `"model": "o3"`, `getenv("OPENAI_MODEL", "o3")`, `["--model", "o3"]`, `model: o3`. `pollutant = "o3"`,
 * `["o1", "o2", "o3"]`, `REASON_CODE = "o1"` and `"Using o3"` don't.
 */
function shortIdIsModel(text: string, at: number, chunk: string, raw: string): boolean {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = text.indexOf("\n", at);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  if (chunk.trim() !== raw) {
    // A config line: the name has to stand alone between delimiters (`model = o3 ; note`, `{ model: o3 }`).
    if (chunk !== line) return false;
    const end = at + raw.length;
    if (!/[\s"'=:[,{(]/.test(text[at - 1] ?? " ") || !/^(?:[\s"',\]});#]|$)/.test(text.slice(end, end + 1))) return false;
  }
  let before = text.slice(lineStart, at);
  const previous = text.slice(text.lastIndexOf("\n", lineStart - 2) + 1, Math.max(0, lineStart - 1));
  if ((before.trim() === "" || /^\s*["'`]$/.test(before)) && /[=:]\s*$/.test(previous)) {
    before = `${previous} ${before}`; // `X =\n  "o3"` (Prettier wrapped the assignment)
  }
  // The key or name this value is given to: the text after the last separator before it. When that holds only
  // neutral words (`default=`, nothing at all), the whole line before the value decides.
  const key = before.slice(Math.max(...[",", "{", "(", "[", ";"].map((c) => before.lastIndexOf(c))) + 1);
  const words = (key.match(/[A-Za-z_$][\w$-]*/g) ?? []).filter((w) => !NEUTRAL_WORDS.test(w));
  return MODEL_CONTEXT.test(words.length > 0 ? words.join(" ") : before);
}

/** One clause on what the replacement changes for a text model's callers. */
function targetSummary(notice: OpenAINotice): string {
  const rules = TARGETS.get(notice.replacement)!;
  const parts = [notice.reasoning
    ? "a reasoning model with the same default effort (medium)"
    : "a reasoning model (default reasoning effort: medium)"];
  if (rules.chatTools === "responses-only") parts.push("tool calls need the Responses API");
  if (!rules.none) parts.push('no "none" or "minimal" effort, so no temperature/top_p');
  return parts.join("; ");
}

type Via = "sdk" | "langchain" | "litellm" | "raw";
type Api = "chat" | "responses";
/**
 * - `swap`: a retiring text model `--fix` can replace; `pro`: gpt-5-pro / o3-pro;
 * - `current`: already a GPT-6 model (its own rules still apply); `maybe`: a variable that may hold a retiring ID.
 */
type ModelState = "swap" | "pro" | "current" | "maybe";

interface Classified {
  state: Exclude<ModelState, "maybe">;
  /** The GPT-6 model the call runs on after the migration (a key of TARGETS). */
  target: string;
  notice?: OpenAINotice;
}

interface Resolved extends Classified {
  /** Where the ID was set when it came from an assignment or a parameter default in this file. */
  setAt?: [number, number];
  /** "maybe" stands in for the classified state when the ID was only suspected. */
  maybe: boolean;
  /** Why a "maybe" model is suspected. */
  note?: string;
  /** Repo defaults for this model name disagree: different replacements, different rules. */
  mixed?: boolean;
  /** "<file>:<line>" of each repo default a "maybe" model may come from. */
  origins?: string[];
}

const ENV_NAME = /(?:getenv|environ\.get|environ\[|process\.env\.|process\.env\[|env\()\s*\(?\s*["']?([A-Za-z_][A-Za-z0-9_]*)/;

interface CallSite {
  at: number;
  via: Via;
  api: Api;
  group: Entry[];
  open: number;
  /** Keys set on a spread options dict after it was built (`args["tools"] = ...`). */
  extraKeys: Set<string>;
  /** The spread dict is changed in ways this tool can't read (`params.update(...)`, `Object.assign(params, ...)`). */
  mutated: boolean;
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
      sites.push({ at, via, api, group: group.entries, open: group.open, extraKeys: new Set(), mutated: false });
      return;
    }
    // `create(**create_params)`: the options dict built just before the call holds the model. JS often passes
    // the object itself (`create(params)`), which reads the same way.
    const args = entries(src, open, close);
    const passed = args.length === 1 && (args[0]!.style === "positional" || args[0]!.style === "shorthand") && /^[A-Za-z_$][\w$]*$/.test(valueText(src, args[0]!))
      ? [args[0]!] : [];
    for (const spread of [...spreadsIn(src, open, close, 0), ...passed]) {
      const dict = spreadDict(src, spreadName(src, spread), at);
      if (dict?.entries.some((e) => e.key && MODEL_KEYS.has(e.key))) {
        // `create(**params, tools=tools)`: the call's own arguments and other spreads count too.
        const owner = enclosingOpen(src, spread.start);
        const own = entries(src, owner, matchingClose(src, owner))
          .filter((e) => e.start !== spread.start && (e.key || e.style === "spread"));
        sites.push({
          at, via, api, group: [...dict.entries, ...own], open: dict.open, extraKeys: dict.extraKeys, mutated: dict.mutated,
        });
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

function classify(id: string): Classified | null {
  const parsed = parseModelId(id);
  if (parsed && !parsed.fineTune) {
    const notice = noticeFor(parsed.base)!;
    if (notice.group === "text") return { state: "swap", target: notice.replacement, notice };
    if (notice.group === "pro") return { state: "pro", target: SOL_61, notice };
  }
  const bare = stripPrefix(id);
  return TARGETS.has(bare) ? { state: "current", target: bare } : null;
}

/** A retiring text or pro model: the IDs worth following from a default into a call. */
function retiring(id: string): boolean {
  const state = classify(id)?.state;
  return state === "swap" || state === "pro";
}

function resolveModel(
  src: Source, entry: Entry, fileSwap: Classified | undefined, defaults: RepoDefaults,
): Resolved | null {
  const found = resolveInFile(src, entry);
  if (found) return { ...found, maybe: false };
  if (found === null) return null;
  const value = entry.style === "shorthand" ? entry.key! : valueText(src, entry);
  const last = /(\.?)([A-Za-z_$][\w$]*)\s*\)?\s*$/.exec(value);
  const keys = [ENV_NAME.exec(value)?.[1]?.toLowerCase(), last?.[2]?.toLowerCase()];
  if (last?.[1]) keys.push(`.${last[2]!.toLowerCase()}`); // `agent.model` → a class field named model
  for (const key of keys) {
    const lines = key ? defaults.get(key)?.split("\n") ?? [] : [];
    const suspects = lines.map((l) => classify(l.slice(l.lastIndexOf(" ") + 1)));
    const suspect = suspects[0];
    if (suspect) {
      return {
        ...suspect, maybe: true, mixed: new Set(suspects.map((c) => c?.target)).size > 1, origins: lines.map((l) => l.slice(0, l.lastIndexOf(" sets "))),
        note: ` The model may come from there: ${lines.join("; ")}.`,
      };
    }
  }
  return fileSwap
    ? { ...fileSwap, maybe: true, note: " The model comes from a variable; this file also names a retiring ID." }
    : null;
}

/** The model from this file alone; null = some other model, undefined = can't tell. */
function resolveInFile(src: Source, entry: Entry): (Classified & { setAt?: [number, number] }) | null | undefined {
  const literals = idsIn(src, entry.valueStart, entry.end);
  for (const id of literals) {
    const found = classify(id);
    if (found) return found;
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
        const found = classify(id);
        if (found) return { ...found, setAt: [m.index, m.index + m[0].length] };
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
      const found = classify(m[2]!);
      if (found) return { ...found, setAt: [m.index, m.index + m[0].length] };
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
  mutated: boolean;
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
    found = { open, entries: entries(src, open, close), extraKeys: new Set(), mutated: false };
  }
  if (!found) return null;
  const later = new RegExp(`(?<![\\w$.])${bare}\\s*(?:\\[\\s*["']([\\w$]+)["']\\s*\\]|\\.([A-Za-z_$][\\w$]*))\\s*=(?!=)`, "g");
  for (const m of src.text.slice(found.open, before).matchAll(later)) {
    if (src.mask[found.open + m.index] === CODE) found.extraKeys.add((m[1] ?? m[2])!);
  }
  const mutate = new RegExp(`(?<![\\w$.])${bare}\\s*\\.\\s*(?:update|setdefault|__setitem__)\\s*\\(|Object\\.assign\\(\\s*${bare}\\b`, "g");
  for (const m of src.text.slice(found.open, before).matchAll(mutate)) {
    if (src.mask[found.open + m.index] === CODE) found.mutated = true;
  }
  return found;
}

const EDIT_VIAS = new Set<string>(["sdk:py", "sdk:js", "raw:py", "raw:js", "litellm:py", "langchain:py"]);

function analyzeCallSites(
  file: string, src: Source, out: OpenAIScan, defaults: RepoDefaults, today: string,
): void {
  const sites = findCallSites(src);
  holdWrappers(src, out, new Set(sites.map((s) => s.open)));
  if (sites.length === 0) return;
  const fileSwap = src.strings
    .filter((s) => !s.block && isSetting(src.text, s.start, s.end, s.value))
    .flatMap((s) => [...s.value.matchAll(TOKEN)].map((m) => classify(m[0])))
    .find((c) => c?.state === "swap" || c?.state === "pro") ?? undefined;
  const instructorToolMode = /\b(?:instructor\.)?(?:from_openai|patch)\s*\(/.test(src.text) &&
    /\bimport\s+instructor\b|\bfrom\s+instructor\b/.test(src.text) &&
    !/Mode\.(?!TOOLS\b|PARALLEL_TOOLS\b|TOOLS_STRICT\b)[A-Z_]+/.test(src.text);
  const langchainTools = [...src.text.matchAll(new RegExp(LANGCHAIN_TOOLS, "g"))]
    .some((m) => src.mask[m.index] === CODE);

  const proVetoes: [number, number][] = [];
  const textLines = src.text.split("\n");
  for (const site of sites) {
    const modelEntry = site.group.find((e) => e.key && MODEL_KEYS.has(e.key))!;
    const resolved = resolveModel(src, modelEntry, fileSwap, defaults);
    if (!resolved) continue;
    const { state, target, maybe } = resolved;
    const rules: TargetRules = TARGETS.get(target)!;
    const days = resolved.notice ? daysUntil(resolved.notice.date, today) : undefined;
    const urgent = days !== undefined && days <= URGENT_DAYS;
    // A shutdown more than 90 days out is a warning, and so is what its call sites need.
    const far = days !== undefined && days > SOON_DAYS;

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
    // `**opts` built somewhere this file doesn't show, or an effort set on the dict after it was built
    // (`params["reasoning_effort"] = ...`): either may carry settings that clash with the new model.
    const unseenSpread = site.mutated ||
      site.group.some((e) => {
        if (e.style !== "spread") return false;
        const dict = spreadDict(src, spreadName(src, e), site.at);
        return !dict || dict.mutated;
      }) ||
      [...EFFORT_KEYS].some((k) => extraKeys.has(k));
    let api = site.api;
    const responsesFlag = byKey.get("use_responses_api") ?? byKey.get("useResponsesApi");
    if (site.via === "langchain" && responsesFlag && /true/i.test(valueText(src, responsesFlag))) api = "responses";

    // instructor's default Mode.TOOLS turns `response_model=` into a forced tool call.
    const instructorTools = instructorToolMode && has("response_model");
    const hasTools = [...TOOL_KEYS].some(has) || (site.via === "langchain" && langchainTools) ||
      instructorTools;
    const sampling = [...SAMPLING_KEYS].filter(has);
    const effortEntry = [...EFFORT_KEYS].map((k) => byKey.get(k)).find(Boolean);
    const effortValue = effortEntry
      ? /["'](none|minimal|low|medium|high|xhigh|max)["']/.exec(valueText(src, effortEntry))?.[1]
      : undefined;
    const effortNone = effortValue === "none";
    const maxTokens = byKey.get("max_tokens");

    const line = lineOf(src.text, site.at);
    // An options dict several calls spread: a setting one call needs would reach the others too.
    const sharedDict = sites.some((other) => other !== site && other.open === site.open);
    const editable = !maybe && !sharedDict && EDIT_VIAS.has(`${site.via}:${src.language}`);
    // --fix can add `reasoning_effort: "none"` when the target takes it and the call sets no effort yet.
    const canAddNone = editable && state !== "pro" && rules.none && !effortEntry && !unseenSpread;
    /** `fix`: "none" = fixed when --fix adds effort none; "pro" = fixed by the pro-mode swap; "rename" = always. */
    type Fix = "none" | "pro" | "rename" | null;
    const pending: { rule: string; severity: Severity; message: string; fix: Fix }[] = [];
    const push = (rule: string, severity: Severity, message: string, fix: Fix = null) =>
      pending.push({ rule, severity, message, fix });
    const label = `${viaLabel(site.via)} ${api === "chat" ? "Chat Completions" : "Responses"} call`;
    /** Something only a person can change: the ID swap would leave a failing call. */
    let manual = false;
    // `# llm-retire-scan: ignore` on the call: its findings go, and so does the swap of the ID it reads.
    if (ignoredLine(textLines, line)) manual = true;
    // `model="gpt-5-nano" if fast else "gpt-5"`: two IDs with their own rules in one argument.
    const ids = idsIn(src, modelEntry.valueStart, modelEntry.end).filter((v) => classify(v));
    if (new Set(ids.map((v) => classify(v)!.target)).size > 1) {
      push("model-varies", "warn",
        `${label} picks between ${ids.join(" and ")}, which move to different models with different rules: ` +
        "migrate each branch by hand.");
      manual = true;
    }
    if (resolved.mixed) {
      push("model-varies", "warn",
        `${label}: the model default is set more than once in the repo, to IDs with different replacements; ` +
        "check this call against each.");
      manual = true;
    }
    let wantNone = false;

    if (state === "pro") {
      if (api === "chat") {
        push("pro-responses-only", "error",
          `${label}: the replacement for pro is ${SOL_61} with reasoning.mode "pro", documented for the Responses ` +
          "API only. Move this call to Responses; --fix leaves it.");
        manual = true;
      } else if (editable && !effortEntry && !unseenSpread && modelLiteral(src, modelEntry, true)) {
        push("pro-mode", "error",
          `${label}: --fix swaps the model to ${SOL_61} and adds reasoning: { mode: "pro" } (pro mode bills more ` +
          "model work than standard).", "pro");
      } else {
        push("pro-mode", "error",
          `${label}: set the model to ${SOL_61} and add "mode": "pro" to its reasoning settings by hand.`);
        manual = true;
      }
    }

    if (hasTools && api === "chat" && state !== "pro") {
      if (rules.chatTools === "responses-only") {
        push("tools-responses-only", "error",
          `${label} sends tools${instructorTools ? " (instructor Mode.TOOLS turns response_model into one)" : ""}. ` +
          `${target} takes tool calls only on the Responses API, at any reasoning effort: move this call to Responses.`);
        manual = true;
      } else if (!effortNone) {
        push("tools-effort", "error",
          `${label} sends tools${instructorTools ? " (instructor Mode.TOOLS turns response_model into one)" : ""}. On ${target}, Chat Completions supports function calling only with ` +
          `reasoning_effort "none"` + (effortEntry ? "; this call sets another effort (use none, or move to Responses)." :
            "; the default is medium. Set it to none, or move this call to the Responses API to keep reasoning."),
          "none");
        wantNone = true;
      }
    }
    if (sampling.length > 0 && !effortNone) {
      if (rules.none) {
        push("sampling-effort", "error",
          `${label} sets ${sampling.join(", ")}. On ${target}, temperature, top_p and top_logprobs (and logprobs on ` +
          'Chat Completions) are rejected unless reasoning effort is "none".', "none");
        wantNone = true;
      } else {
        push("sampling-effort", "error",
          `${label} sets ${sampling.join(", ")}. ${target} has no "none" effort, and temperature, top_p and ` +
          "top_logprobs (logprobs on Chat Completions) are rejected at every other effort: remove them.");
        manual = true;
      }
    }
    if (effortValue && !rules.efforts.includes(effortValue)) {
      push("effort-value", "error",
        `${label} sets reasoning effort "${effortValue}"; ${target} takes ${rules.efforts.join(", ")}.` +
        (effortValue === "minimal" ? ' OpenAI\'s migration guide: "If your existing request uses minimal, start with low".' : ""));
      manual = true;
    }
    if (maxTokens && api === "chat" && (site.via === "sdk" || site.via === "raw") && !maybe) {
      const renamable = editable && state !== "pro" && maxTokens.keyStart !== undefined;
      push("max-tokens", "warn",
        `${label} sets max_tokens, deprecated in favour of max_completion_tokens; on a reasoning model the limit ` +
        "also has to cover reasoning tokens.", renamable ? "rename" : null);
      if (renamable) {
        out.edits.push({ start: maxTokens.keyStart!, end: maxTokens.keyStart! + "max_tokens".length, text: "max_completion_tokens" });
      }
    }
    const toolsFlagged = hasTools && api === "chat";
    const wasPlain = state === "swap" && !resolved.notice?.reasoning;
    if ((wasPlain || (state === "current" && rules.none)) && !toolsFlagged && sampling.length === 0 && !effortEntry) {
      push("default-effort", "warn",
        `${label}: ${state === "swap" ? "after the swap it runs" : "it runs"} at the default medium reasoning effort ` +
        `(slower, and reasoning tokens are billed as output). Set the effort explicitly; "none" skips reasoning.`);
    }

    // Swapping the ID alone would leave a call that fails on the new model: keep the old ID for a human.
    const blocked = manual || (wantNone && !canAddNone) || unseenSpread;
    const addNone = wantNone && canAddNone && !(state === "swap" && blocked);
    const proFix = state === "pro" && !manual && pending.some((p) => p.fix === "pro");
    const siteFindings: Finding[] = [];
    for (const p of pending) {
      const fixable = p.fix === "rename" || (p.fix === "none" && addNone) || (p.fix === "pro" && proFix);
      siteFindings.push({
        file, line, provider: "openai", rule: p.rule, severity: maybe || far ? "warn" : p.severity, urgent,
        message: p.message + (p.fix === "pro" && !proFix ? " Not this time: fix the other findings on this call first." : "") +
          (resolved.note ?? ""),
        fixable,
      });
    }
    out.findings.push(...siteFindings);
    if (state === "swap" && blocked && resolved.origins) out.holds.push(...resolved.origins);
    if (state === "swap" && blocked) {
      const spans: [number, number][] = [[modelEntry.valueStart, modelEntry.end]];
      if (resolved.setAt) spans.push(resolved.setAt);
      holdSwap(src.text, out, spans, unseenSpread && !manual && !wantNone
        ? " --fix leaves this call: it spreads options defined elsewhere (or sets the effort after building them), which may clash with the new model."
        : " --fix leaves this call: change its tools, sampling or effort settings by hand first (see the call-site finding).");
    } else if (addNone) {
      const edit = paramEdit(src, site, modelEntry, api === "chat" ? "effort-chat" : "effort-responses");
      out.edits.push(edit);
      if (state === "swap") {
        const needs: [number, number][] = [[modelEntry.valueStart, modelEntry.end]];
        if (resolved.setAt) needs.push(resolved.setAt);
        out.links.push({ edit, needs, findings: siteFindings.filter((f) => f.fixable && f.rule !== "max-tokens") });
      }
    }
    if (proFix) proSwap(src, out, modelEntry, site, siteFindings.filter((f) => f.fixable));
    // A pro call that needs a manual change: no other call may move the ID it shares (an options dict, a constant).
    if (state === "pro" && manual) {
      proVetoes.push([modelEntry.valueStart, modelEntry.end]);
      if (resolved.setAt) proVetoes.push(resolved.setAt);
    }
  }
  out.edits = out.edits.filter((e) => !(e.text === SOL_61 && proVetoes.some(([from, to]) => e.start >= from && e.end <= to)));
}

/** The model ID literal inside a call's model argument (`model="o3-pro"`, `getenv("M", "o3-pro")`). */
function modelLiteral(src: Source, model: Entry, whole = false): Source["strings"][number] | undefined {
  const literal = src.strings.find((s) => s.start >= model.valueStart && s.start < model.end && !s.block && parseModelId(s.value));
  // `whole`: the literal is the entire argument, not a `getenv("M", "o3-pro")` default another value may replace.
  if (whole && literal && valueText(src, model).trim() !== src.text.slice(literal.start, literal.end)) return undefined;
  return literal;
}

/**
 * Drops the ID-swap edits inside `spans` (the call's model argument, and the assignment it reads the ID from)
 * and marks their shutdown findings as not fixed.
 */
function holdSwap(text: string, out: OpenAIScan, spans: [number, number][], note: string): void {
  const held = new Set<number>();
  out.edits = out.edits.filter((e) => {
    const inside = TARGETS.has(e.text) && spans.some(([from, to]) => e.start >= from && e.end <= to);
    if (inside) held.add(lineOf(text, e.start));
    return !inside;
  });
  for (const f of out.findings) {
    if (held.has(f.line) && f.rule === "shutdown" && f.fixable) {
      f.fixable = false;
      f.message += note;
    }
  }
}

const RISKY_KEYS = new Set([...TOOL_KEYS, ...SAMPLING_KEYS]);
const AGNO_RESPONSES = /^\s*OpenAIResponses\s*\(/;
const MODEL_KEY_VALUE = /\b(?:model|model_name|modelName)\s*[=:]\s*(?=[A-Za-z_$])/g;

/**
 * `Agent(model="o3", tools=[...])`, `Agent(llm=LLM(model=MODEL), tools=...)`, `Agent("openai/gpt-5", temperature=0)`:
 * code this tool doesn't know sends tools or sampling settings next to the model. Whether the replacement takes
 * them depends on the API that code calls, which can't be seen from here, so the ID is kept and the reason given.
 */
function holdWrappers(src: Source, out: OpenAIScan, known: ReadonlySet<number>): void {
  const enclosing = enclosingIndex(src);
  const candidates = new Map<number, { open: number; entry: Entry }>();
  const consider = (at: number, positionalOk: boolean) => {
    const open = enclosing[at]!;
    if (open === -1 || known.has(open)) return;
    const close = matchingClose(src, open);
    if (close === -1) return;
    const list = entries(src, open, close);
    const entry = list.find((e) => e.start <= at && at < e.end);
    if (!entry) return;
    const keyed = entry.key !== null && MODEL_KEYS.has(entry.key);
    const positional = positionalOk && entry.style === "positional" && list[0] === entry && src.text[open] === "(";
    if (keyed || positional) candidates.set(entry.start, { open, entry });
  };
  for (const literal of src.strings) {
    if (!literal.block && classify(literal.value)?.state === "swap") consider(literal.start, true);
  }
  for (const m of src.text.matchAll(MODEL_KEY_VALUE)) {
    if (src.mask[m.index] === CODE) consider(m.index + m[0].length, false);
  }

  for (const { open, entry } of candidates.values()) {
    const found = resolveInFile(src, entry);
    if (found?.state !== "swap") continue;
    // agno's `OpenAIResponses(id=...)` sends everything through the Responses API, where tools are fine.
    const risk = AGNO_RESPONSES.test(src.text.slice(entry.valueStart, entry.end)) ? SAMPLING_KEYS : RISKY_KEYS;
    let group = open;
    let risky = false;
    for (let depth = 0; depth < 3 && group !== -1 && !known.has(group); depth += 1) {
      const close = matchingClose(src, group);
      if (close === -1) break;
      if (entries(src, group, close).some((e) => e.key && risk.has(e.key))) {
        risky = true;
        break;
      }
      group = enclosing[group]!;
    }
    if (!risky) continue;
    const spans: [number, number][] = [[entry.valueStart, entry.end]];
    if (found.setAt) spans.push(found.setAt);
    holdSwap(src.text, out, spans,
      ` It goes through code this tool doesn't know, next to tools or sampling settings: check which API that code ` +
      `calls and what ${found.target} accepts there before swapping. --fix leaves it.`);
  }
}

/**
 * For every position, the innermost open bracket around it (-1 at top level): `enclosingOpen` for the whole file
 * in one pass, so walking up from many candidates stays linear.
 */
function enclosingIndex(src: Source): Int32Array {
  const index = new Int32Array(src.text.length + 1);
  const stack: number[] = [];
  for (let i = 0; i <= src.text.length; i += 1) {
    index[i] = stack.length > 0 ? stack[stack.length - 1]! : -1;
    if (i === src.text.length || src.mask[i] !== CODE) continue;
    const ch = src.text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") stack.push(i);
    else if ((ch === ")" || ch === "]" || ch === "}") && stack.length > 0) stack.pop();
  }
  return index;
}

/** gpt-5-pro / o3-pro in a Responses call: swap the literal to gpt-6.1-sol and add `reasoning: { mode: "pro" }`. */
function proSwap(src: Source, out: OpenAIScan, model: Entry, site: CallSite, findings: Finding[]): void {
  const literal = modelLiteral(src, model)!;
  const parsed = parseModelId(literal.value)!;
  const start = literal.start + literal.quote.length + parsed.prefix.length;
  const swap: Edit = { start, end: start + parsed.base.length, text: SOL_61 };
  const insert = paramEdit(src, site, model, "pro");
  out.edits.push(swap, insert);
  const line = lineOf(src.text, literal.start);
  const shutdown = out.findings.filter((f) => f.line === line && f.rule === "shutdown");
  for (const f of shutdown) f.fixable = true;
  out.links.push({ edit: insert, pair: swap, needs: [[swap.start, swap.end]], findings: [...findings, ...shutdown] });
}

type Param = "effort-chat" | "effort-responses" | "pro";

/** Inserts a reasoning setting right after the model argument, in the call's own syntax. */
function paramEdit(src: Source, site: CallSite, model: Entry, param: Param): Edit {
  const quote = src.strings.find((s) => s.start >= model.valueStart && s.start < model.end)?.quote ?? '"';
  const q = quote.length === 1 && quote !== "`" ? quote : '"';
  const [key, inner, value] = param === "effort-chat"
    ? ["reasoning_effort", null, "none"]
    : ["reasoning", param === "pro" ? "mode" : "effort", param === "pro" ? "pro" : "none"];
  let text: string;
  if (model.style === "kwarg") {
    text = inner ? `${key}={${q}${inner}${q}: ${q}${value}${q}}` : `${key}=${q}${value}${q}`;
  } else if (model.style === "quoted") {
    const k = model.keyQuote!;
    text = inner ? `${k}${key}${k}: {${k}${inner}${k}: ${k}${value}${k}}` : `${k}${key}${k}: ${k}${value}${k}`;
  } else {
    text = inner ? `${key}: { ${inner}: ${q}${value}${q} }` : `${key}: ${q}${value}${q}`;
  }
  const multiline = src.text.slice(site.open + 1, model.start).includes("\n");
  return { start: model.end, end: model.end, text: multiline ? `,\n${indentOf(src.text, model.start)}${text}` : `, ${text}` };
}

function viaLabel(via: Via): string {
  return { sdk: "OpenAI SDK", langchain: "LangChain ChatOpenAI", litellm: "LiteLLM", raw: "HTTP" }[via];
}

