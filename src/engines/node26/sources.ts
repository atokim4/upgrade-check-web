import type { FileKind, SourceFile } from "./types.ts";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output", "vendor", "coverage", ".turbo", ".vercel",
  ".netlify", ".venv", "target", ".yarn", ".pnpm-store", "bower_components",
]);
export const MAX_BYTES = 1024 * 1024;
export const MAX_LOCK_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 30000;

const AGENT_DOCS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md"]);
const SOURCE_EXT = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;

export function classify(path: string): FileKind | undefined {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash === -1 ? "." : path.slice(0, slash);
  if (/(^|\/)\.github\/workflows$/.test(dir) && /\.ya?ml$/.test(name)) return "workflow";
  if (/(^|\/)\.github\/actions(\/|$)/.test(dir) && /^action\.ya?ml$/.test(name)) return "workflow";
  if (name === ".gitlab-ci.yml" || /\.gitlab-ci\.ya?ml$/.test(name)) return "gitlab";
  if (name === "Jenkinsfile" || /^Jenkinsfile\./.test(name) || name.endsWith(".jenkinsfile")) return "jenkinsfile";
  if (name === "netlify.toml") return "netlify";
  if (name === "vercel.json") return "vercel";
  if (name === "package.json") return "package";
  if (name === ".nvmrc" || name === ".node-version") return "node-version";
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json" || name === "pnpm-lock.yaml") return "lockfile";
  if (/\.(sh|bash)$/.test(name)) return "shell";
  if (name === "Makefile" || name === "makefile" || name === "GNUmakefile" || name.endsWith(".mk")) return "makefile";
  if (name === "Dockerfile" || name === "Containerfile" || /^Dockerfile\./.test(name) || name.endsWith(".Dockerfile")) return "dockerfile";
  if (AGENT_DOCS.has(name)) return "agent-doc";
  if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts") && !/\.min\.[cm]?js$/.test(name)) return "source";
  return undefined;
}

export interface Repo {
  root: string;
  files: SourceFile[];
  truncated: boolean;
}

export interface Span {
  start: number;
  end: number;
}

/** Shell-bearing keys: GitHub `run`, GitLab `script` / `before_script` / `after_script`. */
const YAML_SHELL_KEY = /^(\s*)(?:-\s+)?(run|script|before_script|after_script):[ \t]*(.*)$/;

/** Shell spans inside CI YAML: the inline value, or the indented block under the key. */
export function yamlShellSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lines = text.split("\n");
  const offsets = lineOffsets(lines);
  for (let i = 0; i < lines.length; i++) {
    const m = YAML_SHELL_KEY.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const value = m[3]!;
    const valueStart = offsets[i]! + lines[i]!.length - value.length;
    if (value && !/^[|>][-+0-9]*\s*(#.*)?$/.test(value)) {
      const q = value[0];
      const v = value.trimEnd();
      if ((q === '"' || q === "'") && v.endsWith(q) && v.length > 1) spans.push({ start: valueStart + 1, end: valueStart + v.length - 1 });
      else spans.push({ start: valueStart, end: offsets[i]! + lines[i]!.length });
    }
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "") continue;
      if (l.length - l.trimStart().length <= indent) break;
    }
    if (j > i + 1) {
      const items = lines.slice(i + 1, j).filter((l) => l.trim() !== "");
      if (items.length > 0 && /^\s*-\s/.test(items[0]!)) {
        // GitLab-style list: each `- item` is one command (quotes around a whole item stripped).
        for (let k = i + 1; k < j; k++) {
          const item = /^(\s*-\s+)(.*?)\s*$/.exec(lines[k]!);
          if (!item || !item[2]) continue;
          const s = offsets[k]! + item[1]!.length;
          const body = item[2];
          const quoted = body.length > 1 && (body[0] === '"' || body[0] === "'") && body.endsWith(body[0]);
          spans.push(quoted ? { start: s + 1, end: s + body.length - 1 } : { start: s, end: s + body.length });
        }
      } else {
        spans.push({ start: offsets[i + 1]!, end: offsets[j - 1]! + lines[j - 1]!.length });
      }
      i = j - 1;
    }
  }
  return spans;
}

/** Spans of the string values of the given top-level keys of a JSON object (no nesting). */
function jsonStringSpans(text: string, keys: readonly string[], within?: Span): { key: string; start: number; end: number }[] {
  const spans: { key: string; start: number; end: number }[] = [];
  const from = within?.start ?? 0;
  const to = within?.end ?? text.length;
  for (const key of keys) {
    const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`, "g");
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m || m.index >= to) continue;
    const start = m.index + m[0].length;
    let end = start;
    while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
    spans.push({ key, start, end });
  }
  return spans;
}

/** package.json `scripts` values, as spans of the raw file text. */
export function packageScriptSpans(text: string): { name: string; start: number; end: number }[] {
  let json: { scripts?: Record<string, unknown> };
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = json.scripts && typeof json.scripts === "object" ? json.scripts : {};
  const at = text.search(/"scripts"\s*:\s*\{/);
  if (at === -1) return [];
  const names = Object.keys(scripts).filter((n) => typeof scripts[n] === "string");
  const close = matchingBrace(text, text.indexOf("{", at));
  return jsonStringSpans(text, names, { start: at, end: close }).map((s) => ({ name: s.key, start: s.start, end: s.end }));
}

/** vercel.json `installCommand`, `buildCommand`, `devCommand`. */
export function vercelCommandSpans(text: string): Span[] {
  return jsonStringSpans(text, ["installCommand", "buildCommand", "devCommand"]);
}

/** netlify.toml `command = "…"` values (build and context sections), single or triple quoted. */
export function netlifyCommandSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /^[ \t]*command[ \t]*=[ \t]*("""|'''|"|')/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const q = m[1]!;
    const start = m.index + m[0].length;
    const end = text.indexOf(q, start);
    if (end !== -1) spans.push({ start, end });
  }
  return spans;
}

/** Fenced code blocks and inline code spans in Markdown: the only places a doc tells an agent to run a command. */
export function markdownCodeSpans(text: string): Span[] {
  const spans: Span[] = [];
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm;
  const fenced: Span[] = [];
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const start = m.index + m[0].indexOf("\n") + 1;
    spans.push({ start, end: start + m[3]!.length });
    fenced.push({ start: m.index, end: m.index + m[0].length });
  }
  const inline = /`([^`\n]+)`/g;
  for (let m = inline.exec(text); m; m = inline.exec(text)) {
    const at = m.index;
    if (fenced.some((f) => at >= f.start && at < f.end)) continue;
    spans.push({ start: at + 1, end: at + 1 + m[1]!.length });
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return text.length;
}

export function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) { offsets.push(at); at += l.length + 1; }
  return offsets;
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export function lineText(text: string, line: number): string {
  return text.split("\n")[line - 1] ?? "";
}

export function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
