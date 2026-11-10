import type { Context, SourceFile } from "./types.ts";

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output", "vendor", "coverage", ".turbo", ".vercel", ".netlify", ".venv", "target"]);
export const MAX_BYTES = 1024 * 1024;
export const MAX_FILES = 20000;

const AGENT_DOCS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".clinerules", "copilot-instructions.md"]);
const CI_OTHER = new Set(["bitbucket-pipelines.yml", "azure-pipelines.yml"]);

export function classify(path: string): SourceFile["kind"] | undefined {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash === -1 ? "." : path.slice(0, slash);
  if (/(^|\/)\.github\/workflows$/.test(dir) && /\.ya?ml$/.test(name)) return "workflow";
  if (/(^|\/)\.github\/actions(\/|$)/.test(dir) && /^action\.ya?ml$/.test(name)) return "workflow";
  if (name === ".gitlab-ci.yml" || /\.gitlab-ci\.ya?ml$/.test(name)) return "gitlab";
  if (CI_OTHER.has(name) || (/(^|\/)\.circleci$/.test(dir) && name === "config.yml")) return "ci-other";
  if (name === "package.json") return "package";
  if (/\.(sh|bash)$/.test(name)) return "shell";
  if (name === "Makefile" || name === "makefile" || name === "GNUmakefile" || name.endsWith(".mk")) return "makefile";
  if (name === "Dockerfile" || /^Dockerfile\./.test(name) || name.endsWith(".Dockerfile")) return "dockerfile";
  if (/(^|\/)supabase$/.test(dir) && name === "config.toml") return "config-toml";
  if (/(^|\/)supabase$/.test(dir) && name === "config.json") return "config-json";
  if (/^\.env(\.[\w-]+)*$/.test(name) && !/\.(example|sample|template|dist|defaults)$/.test(name)) return "env";
  if (AGENT_DOCS.has(name)) return "agent-doc";
  if (/(^|\/)\.cursor\/rules(\/|$)/.test(dir) && /\.mdc?$/.test(name)) return "agent-doc";
  if (/(^|\/)\.claude\/(commands|agents)(\/|$)/.test(dir) && name.endsWith(".md")) return "agent-doc";
  return undefined;
}

export interface Repo {
  root: string;
  files: SourceFile[];
  /** Every path walked (including files that aren't read), relative, forward slashes. */
  paths: string[];
  truncated: boolean;
}

/** A span of a file that holds shell code, and how that code runs. */
export interface Region {
  file: SourceFile;
  start: number;
  end: number;
  context: Context;
  /** Text to lex: the file text, with JSON string escapes masked so offsets still line up. */
  lexText: string;
  /** package.json script name, when the region is one. */
  script?: string;
}

const CI_KINDS = new Set<SourceFile["kind"]>(["workflow", "gitlab", "ci-other"]);
export const isCi = (f: SourceFile) => CI_KINDS.has(f.kind);

/** Shell-bearing keys: GitHub `run`, GitLab/Bitbucket `script`, CircleCI `command`. */
const YAML_SHELL_KEY = /^(\s*)(?:-\s+)?(run|script|before_script|after_script|command):[ \t]*(.*)$/;

/** Shell spans inside CI YAML: the inline value, or the indented block under the key. */
export function yamlShellSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) { offsets.push(at); at += l.length + 1; }
  for (let i = 0; i < lines.length; i++) {
    const m = YAML_SHELL_KEY.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const value = m[3]!;
    const valueStart = offsets[i]! + lines[i]!.length - value.length;
    if (value && !/^[|>][-+0-9]*\s*(#.*)?$/.test(value)) {
      const q = value[0];
      if ((q === '"' || q === "'") && value.trimEnd().endsWith(q) && value.trimEnd().length > 1) {
        spans.push({ start: valueStart + 1, end: valueStart + value.trimEnd().length - 1 });
      } else spans.push({ start: valueStart, end: offsets[i]! + lines[i]!.length });
    }
    // The block: following lines indented deeper than the key (blank lines included).
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

/** package.json `scripts` values, as spans of the raw file text. */
export function packageScriptSpans(text: string): { name: string; start: number; end: number }[] {
  let json: { scripts?: Record<string, unknown> };
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = json.scripts && typeof json.scripts === "object" ? json.scripts : {};
  const scriptsAt = text.search(/"scripts"\s*:\s*\{/);
  if (scriptsAt === -1) return [];
  const spans: { name: string; start: number; end: number }[] = [];
  let cursor = scriptsAt;
  for (const name of Object.keys(scripts)) {
    if (typeof scripts[name] !== "string") continue;
    const key = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`, "g");
    key.lastIndex = cursor;
    const m = key.exec(text);
    if (!m) continue;
    const start = m.index + m[0].length;
    let end = start;
    while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
    spans.push({ name, start, end });
    cursor = end;
  }
  return spans;
}

/** Fenced code blocks and inline code spans in Markdown: the only places a doc tells an agent to run a command. */
export function markdownCodeSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm;
  const fenced: { start: number; end: number }[] = [];
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const start = m.index + m[0].indexOf("\n") + 1;
    const span = { start, end: start + m[3]!.length };
    spans.push(span);
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

/** JSON string escapes `\"` and `\\` become blank + char, so the lexer sees shell quotes at the same offsets. */
const maskJsonEscapes = (text: string) => text.replace(/\\(["\\])/g, " $1");

/**
 * The shell-bearing spans of a file and how they run: CI steps can't prompt, agent docs are read by agents,
 * scripts run in a terminal unless CI reaches them. (`$ supabase …` prompts in docs need nothing special: the
 * lexer treats `$` as a launcher word.)
 */
export function regionsOf(file: SourceFile, ciScripts: Set<string>, ciFiles: Set<string>): Region[] {
  const whole = (context: Context): Region[] => [{ file, start: 0, end: file.text.length, context, lexText: file.text }];
  switch (file.kind) {
    case "workflow":
    case "gitlab":
    case "ci-other":
      return yamlShellSpans(file.text).map((s) => ({ file, ...s, context: "ci" as const, lexText: file.text }));
    case "package": {
      const lexText = maskJsonEscapes(file.text);
      return packageScriptSpans(file.text).map((s) => ({
        file,
        start: s.start,
        end: s.end,
        script: s.name,
        context: ciScripts.has(s.name) || ciFiles.has(file.path) ? ("ci" as const) : ("script" as const),
        lexText,
      }));
    }
    case "shell":
    case "makefile":
    case "dockerfile":
      return whole(ciFiles.has(file.path) ? "ci" : "script");
    case "agent-doc":
      return markdownCodeSpans(file.text).map((s) => ({ file, ...s, context: "agent" as const, lexText: file.text }));
    default:
      return [];
  }
}

const SCRIPT_RUN = /\b(?:npm\s+run(?:-script)?|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([\w:.@/-]+)/g;
const SHELL_FILE = /(?:^|[\s"'=])(?:\.\/)?([\w./-]+\.(?:sh|bash))\b/g;
const PNPM_BUILTINS = new Set(["install", "i", "add", "exec", "dlx", "ci", "test", "run", "x", "build", "--filter", "-r"]);

/**
 * Which package.json scripts and script files CI runs: `npm run deploy`, `./scripts/deploy.sh`, `make`, and
 * what those run in turn. A command reached from CI can't prompt either.
 */
export function ciReach(files: SourceFile[]): { scripts: Set<string>; files: Set<string> } {
  const scripts = new Set<string>();
  const reached = new Set<string>();
  const shellFiles = files.filter((f) => f.kind === "shell");
  const makefiles = files.filter((f) => f.kind === "makefile");
  const scan = (text: string) => {
    for (const m of text.matchAll(SCRIPT_RUN)) if (!PNPM_BUILTINS.has(m[1]!)) scripts.add(m[1]!);
    for (const m of text.matchAll(SHELL_FILE)) {
      const ref = m[1]!.replace(/^\.\//, "");
      for (const f of shellFiles) if (f.path === ref || f.path.endsWith(`/${ref}`)) reached.add(f.path);
    }
    if (/(^|[\s;&|])make(\s|$)/m.test(text)) for (const f of makefiles) reached.add(f.path);
  };
  for (const f of files.filter(isCi)) scan(f.text);
  // Scripts that run other scripts: iterate until nothing new is reached.
  for (let changed = true; changed; ) {
    const before = scripts.size + reached.size;
    for (const f of files) {
      if (f.kind === "package") {
        for (const s of packageScriptSpans(f.text)) if (scripts.has(s.name)) scan(f.text.slice(s.start, s.end));
      } else if (reached.has(f.path)) scan(f.text);
    }
    changed = scripts.size + reached.size !== before;
  }
  return { scripts, files: reached };
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export function lineText(text: string, line: number): string {
  return text.split("\n")[line - 1] ?? "";
}
