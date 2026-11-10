// A small shell lexer: enough of POSIX sh to find `supabase …` invocations inside CI steps, scripts and docs,
// with exact character offsets so --fix can rewrite single tokens without touching anything around them.

export interface Token {
  /** The word with quotes and escapes removed. */
  value: string;
  /** The word exactly as written. */
  raw: string;
  start: number;
  end: number;
  /** A redirection such as `> types.ts` or `2>&1` (the target is part of the token). */
  redirect?: boolean;
}

type Lexeme = Token | { op: string; start: number; end: number };

const isOp = (l: Lexeme): l is { op: string; start: number; end: number } => "op" in l;

/**
 * Splits `text[from, to)` into words and operators. Line continuations count as blanks, `#` at the start of a
 * word starts a comment, `${…}` (including GitHub's `${{ … }}`) stays inside the word.
 */
export function lex(text: string, from = 0, to = text.length): Lexeme[] {
  const out: Lexeme[] = [];
  let i = from;
  const blank = (c: string | undefined) => c === " " || c === "\t" || c === "\r";

  while (i < to) {
    const c = text[i]!;
    if (blank(c)) { i++; continue; }
    if (c === "\\" && text[i + 1] === "\n") { i += 2; continue; }
    if (c === "#") {
      while (i < to && text[i] !== "\n") i++;
      continue;
    }
    if (c === "\n" || c === ";" || c === "(" || c === ")" || c === "`") { out.push({ op: c, start: i, end: i + 1 }); i++; continue; }
    if (c === "|" || c === "&") {
      const two = text.slice(i, i + 2);
      if (two === "||" || two === "&&") { out.push({ op: two, start: i, end: i + 2 }); i += 2; continue; }
      if (c === "&" && text[i + 1] === ">") { i = readWord(text, i, to, out, true); continue; }
      out.push({ op: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") { out.push({ op: "(", start: i, end: i + 2 }); i += 2; continue; }
    const redirect = c === ">" || c === "<" || (/[0-9]/.test(c) && /^[0-9]+[<>]/.test(text.slice(i, i + 4)));
    i = readWord(text, i, to, out, redirect);
  }
  return out;
}

function readWord(text: string, i: number, to: number, out: Lexeme[], redirect: boolean): number {
  const start = i;
  if (redirect) {
    // `>file`, `> file`, `2>>log`, `2>&1`, `&>out`: the operator and its target make one token.
    const op = /^[0-9]*(?:&>>|&>|>>|>&|<&|>|<)/.exec(text.slice(i, Math.min(to, i + 5)))?.[0] ?? text[i]!;
    i += op.length;
    if (op.endsWith("&") && /[0-9-]/.test(text[i] ?? "")) i++;
    else {
      while (i < to && (text[i] === " " || text[i] === "\t")) i++;
      if (i < to && !/[\s;|&()`<>]/.test(text[i]!)) i = readPlain(text, i, to).end;
    }
    out.push({ value: text.slice(start, i).replace(/\s+/g, " "), raw: text.slice(start, i), start, end: i, redirect: true });
    return i;
  }
  const { value, end } = readPlain(text, i, to);
  out.push({ value, raw: text.slice(start, end), start, end });
  return end;
}

/** One shell word starting at `i`: quotes and escapes removed from `value`. */
function readPlain(text: string, i: number, to: number): { value: string; end: number } {
  let value = "";
  while (i < to) {
    const c = text[i]!;
    if (/[\s;|&()`<>]/.test(c)) break;
    if (c === "\\") {
      if (text[i + 1] === "\n") break;
      value += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close === -1 || close >= to ? to : close;
      value += text.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < to && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < to) { value += text[i + 1]; i += 2; continue; }
        value += text[i++];
      }
      i++;
      continue;
    }
    if (c === "$" && (text[i + 1] === "{" || text[i + 1] === "(")) {
      const end = matchBrace(text, i + 1, to);
      value += text.slice(i, end);
      i = end;
      continue;
    }
    value += c;
    i++;
  }
  return { value, end: Math.min(i, to) };
}

/** End offset (exclusive) of the bracket group that opens at `open`. */
function matchBrace(text: string, open: number, to: number): number {
  const pair: Record<string, string> = { "{": "}", "(": ")" };
  const stack: string[] = [];
  for (let i = open; i < to; i++) {
    const c = text[i]!;
    if (c === "{" || c === "(") stack.push(pair[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return to;
}

export interface Invocation {
  binary: "supabase" | "supabase-go";
  /** The binary token (`supabase`, `npx supabase@3` → the `supabase@3` word). */
  binaryToken: Token;
  /** Everything after the binary up to the end of the simple command. */
  args: Token[];
  /** End of the last argument that isn't a redirection: where a new flag goes. */
  argsEnd: number;
  /** `NAME=value` words in front of the command. */
  envPrefix: Map<string, string>;
  /** The command piped into this one (`echo y | supabase …`), with the span to delete to drop the pipe. */
  pipedFrom?: { words: string[]; start: number; end: number };
}

const LAUNCHERS = new Set(["npx", "bunx", "pnpx", "pnpm", "yarn", "npm", "bun", "dlx", "exec", "x", "sudo", "time", "env", "nohup", "command", "$", "-y", "--yes", "--", "--no-install"]);
const BINARY = /^[@-]?(?:.*\/)?(supabase|supabase-go)(?:@[\w.^~<>=*-]+)?$/;

/** All `supabase` invocations in `text[from, to)`. */
export function findInvocations(text: string, from = 0, to = text.length): Invocation[] {
  const lexemes = lex(text, from, to);
  const commands: { words: Token[]; sepBefore?: { op: string; start: number; end: number } }[] = [];
  let current: Token[] = [];
  let sep: { op: string; start: number; end: number } | undefined;
  for (const l of lexemes) {
    if (isOp(l)) {
      commands.push({ words: current, sepBefore: sep });
      current = [];
      sep = l;
    } else current.push(l);
  }
  commands.push({ words: current, sepBefore: sep });

  const found: Invocation[] = [];
  // Command substitutions inside a word (`x=$(supabase status -o env)`, `"$(…)"`) are commands of their own.
  for (const l of lexemes) {
    if (isOp(l)) continue;
    for (let at = text.indexOf("$(", l.start); at !== -1 && at < l.end; at = text.indexOf("$(", at + 2)) {
      if (text[at + 2] === "(") continue;
      const close = matchBrace(text, at + 1, l.end);
      found.push(...findInvocations(text, at + 2, close - 1));
      at = close - 2;
    }
  }
  commands.forEach((cmd, index) => {
    const envPrefix = new Map<string, string>();
    let k = 0;
    for (; k < cmd.words.length; k++) {
      const w = cmd.words[k]!;
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w.value);
      if (assign && !w.redirect) { envPrefix.set(assign[1]!, assign[2]!); continue; }
      if (LAUNCHERS.has(w.value)) continue;
      break;
    }
    const bin = cmd.words[k];
    const match = bin && !bin.redirect ? BINARY.exec(bin.value) : null;
    if (!bin || !match) return;
    const args = cmd.words.slice(k + 1);
    const lastArg = [...args].reverse().find((t) => !t.redirect);
    const inv: Invocation = {
      binary: match[1] as Invocation["binary"],
      binaryToken: bin,
      args,
      argsEnd: lastArg ? lastArg.end : bin.end,
      envPrefix,
    };
    const prev = commands[index - 1];
    if (cmd.sepBefore?.op === "|" && prev && prev.words.length > 0) {
      inv.pipedFrom = { words: prev.words.map((w) => w.value), start: prev.words[0]!.start, end: firstWordStart(cmd.words) };
    }
    found.push(inv);
  });
  return found.sort((a, b) => a.binaryToken.start - b.binaryToken.start);
}

const firstWordStart = (words: Token[]) => words[0]!.start;

/** Flags that take a value in the next word when it isn't attached with `=`. */
const VALUED = new Set([
  "--project-ref", "--db-url", "--project-id", "--password", "-p", "--file", "-f", "--schema", "-s", "--workdir",
  "--output", "-o", "--output-format", "--env-file", "--from", "--to", "--status", "--lang", "--diff-engine",
  "--override-name", "--jobs", "-j", "--last", "--version", "--profile", "--network-id", "--dns-resolver",
  "--import-map", "--name", "--region", "--org-id", "--db-password", "--size", "--git-branch", "--exclude", "-x",
]);

export interface Flag {
  name: string;
  /** The value, attached (`--x=v`) or the next word (`--x v`). Undefined for booleans. */
  value?: string;
  /** Raw text of the value as written, quotes included. */
  rawValue?: string;
  attached: boolean;
  /** Index of the flag word in `args`. */
  index: number;
  /** Index of the separate value word, when there is one. */
  valueIndex?: number;
}

/** The parts of an invocation the rules look at. */
export interface ParsedCommand {
  /** `db push`, `migration repair`, `inspect db bloat`, `gen types`… */
  path: string[];
  /** Index in `args` of each path word. */
  pathIndex: number[];
  flags: Flag[];
  /** Words that are neither the command path nor flags (nor flag values). */
  positionals: { value: string; index: number }[];
}

/** Known subcommands, so `supabase db push my-arg` gives path `db push` and positional `my-arg`. */
const TREE: Record<string, readonly string[]> = {
  db: ["push", "pull", "dump", "diff", "reset", "query", "lint", "start", "remote", "branch", "schema", "test"],
  "db remote": ["changes", "commit"],
  "db branch": ["create", "delete", "list", "switch"],
  "db schema": ["declarative"],
  "db schema declarative": ["generate", "sync"],
  migration: ["list", "fetch", "repair", "up", "down", "squash", "new"],
  inspect: ["db", "report"],
  gen: ["types", "keys", "signing-key", "bearer-jwt"],
  storage: ["ls", "cp", "mv", "rm"],
  functions: ["deploy", "delete", "download", "serve", "new", "list"],
  secrets: ["set", "unset", "list"],
  config: ["push", "diff"],
  test: ["db", "new"],
  seed: ["buckets"],
  projects: ["create", "delete", "list", "api-keys"],
  orgs: ["create", "list"],
  branches: ["create", "delete", "disable", "pause", "unpause", "update", "list", "get"],
  backups: ["restore", "list"],
  encryption: ["update-root-key", "get-root-key"],
  "network-bans": ["remove", "get"],
  "network-restrictions": ["update", "get"],
  "ssl-enforcement": ["update", "get"],
  "postgres-config": ["update", "delete", "get"],
  sso: ["add", "update", "remove", "list", "show", "info"],
  "vanity-subdomains": ["activate", "delete", "get", "check-availability"],
  domains: ["create", "activate", "delete", "get", "reverify"],
  compute: ["push", "delete"],
  notebooks: ["push"],
  feedback: ["delete"],
};

/** Top-level commands of v2 and v3 (`supabase --help`), so `supabase sql --linked` (not a CLI command) is left alone. */
const TOP_LEVEL = new Set([
  ...Object.keys(TREE).filter((k) => !k.includes(" ")),
  "backups", "bootstrap", "completion", "init", "issue", "link", "login", "logout", "logs", "pull", "services", "snippets",
  "start", "status", "stop", "telemetry", "unlink", "whoami", "stack", "compute", "migration", "migrations",
]);

export const isKnownCommand = (path: readonly string[]) => path.length > 0 && TOP_LEVEL.has(path[0]!);

export function parseCommand(args: readonly Token[]): ParsedCommand {
  const path: string[] = [];
  const pathIndex: number[] = [];
  const flags: Flag[] = [];
  const positionals: { value: string; index: number }[] = [];
  let pathOpen = true;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    if (t.redirect) continue;
    if (t.value.startsWith("-") && t.value.length > 1) {
      const eq = t.value.indexOf("=");
      if (eq > 0 && t.value.startsWith("--")) {
        const rawEq = t.raw.indexOf("=");
        flags.push({ name: t.value.slice(0, eq), value: t.value.slice(eq + 1), rawValue: t.raw.slice(rawEq + 1), attached: true, index: i });
        continue;
      }
      const next = args[i + 1];
      if (VALUED.has(t.value) && next && !next.redirect && !next.value.startsWith("-")) {
        flags.push({ name: t.value, value: next.value, rawValue: next.raw, attached: false, index: i, valueIndex: i + 1 });
        i++;
        continue;
      }
      flags.push({ name: t.value, attached: false, index: i });
      continue;
    }
    if (pathOpen) {
      const parent = path.join(" ");
      if (path.length === 0 || TREE[parent]?.includes(t.value) || parent === "inspect db") {
        path.push(t.value);
        pathIndex.push(i);
        if (parent === "inspect db") pathOpen = false;
        continue;
      }
      pathOpen = false;
    }
    positionals.push({ value: t.value, index: i });
  }
  return { path, pathIndex, flags, positionals };
}
