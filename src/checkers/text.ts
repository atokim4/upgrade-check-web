import type { LoadedRepo } from "../lib/loader.ts";
import type { CodeLine } from "../lib/types.ts";

const JS_LIKE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const HASH_COMMENTS = /\.(?:py|rb|sh|bash|ya?ml|toml|ini|cfg|conf|env\b[^/]*|example|sample)$|(?:^|\/)(?:Dockerfile[^/]*|Containerfile|Makefile|Procfile|\.env[^/]*)$/;

/**
 * The lines of a file with comments left out: `//` and block comments in JS/TS, `#` lines in Python, shell and config
 * files. A line-based approximation (a `//` inside a string ends the line early), good enough for pattern rules.
 */
export function codeLines(path: string, text: string): CodeLine[] {
  const out: CodeLine[] = [];
  const js = JS_LIKE.test(path);
  const hash = !js && HASH_COMMENTS.test(path);
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (js) {
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end === -1) return;
        line = line.slice(end + 2);
        inBlock = false;
      }
      line = line.replace(/\/\*.*?\*\//g, "");
      const open = line.indexOf("/*");
      if (open !== -1 && !/["'`][^"'`]*\/\*/.test(line.slice(0, open + 2))) {
        inBlock = true;
        line = line.slice(0, open);
      }
      line = line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1");
    } else if (hash && /^\s*#/.test(line)) {
      return;
    }
    if (line.trim()) out.push({ line: i + 1, text: line });
  });
  return out;
}

/** Files of the repo whose path passes `accept`, sorted by path. */
export function filesWhere(repo: LoadedRepo, accept: (path: string) => boolean): { path: string; text: string }[] {
  return [...repo.texts].filter(([path]) => accept(path)).map(([path, text]) => ({ path, text })).sort((a, b) => a.path.localeCompare(b.path));
}

export const snippetOf = (text: string) => text.trim().slice(0, 160);

/** The 1-based line a character offset falls on. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
export const isSource = (path: string) => SOURCE_FILE.test(path) && !path.endsWith(".d.ts");
export const isPackageJson = (path: string) => path === "package.json" || path.endsWith("/package.json");
/** Real `.env` files hold secrets and are never read; examples and templates are fine. */
export const isEnvExample = (path: string) => /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults)$/i.test(path);
