// Finds the commands in a span of shell text. Not a full shell parser: it splits on the operators that start a
// new command (; && || | & newline ( ) ` $( ), drops leading env assignments and wrappers like sudo, and keeps
// offsets into the file so a fix can insert text right where the command starts.

export interface Command {
  /** Offset of the first character of the command (env assignments and sudo included). */
  start: number;
  /** Offset just past the command's last character. */
  end: number;
  /** Program name without its path: `corepack`, `yarn`, `npm`. */
  program: string;
  /** Arguments after the program, quotes stripped. */
  args: string[];
  /** The same arguments as written (quotes kept), with their offsets. */
  words: { raw: string; at: number }[];
  /** The command as written. */
  text: string;
}

const WRAPPERS = new Set(["sudo", "exec", "time", "command", "env", "nohup", "then", "do", "else", "if", "while", "until", "!", "$", ">", "-", "{", "}"]);

/** Splits at shell control operators. Quotes are respected unless `quotesSplit` (Jenkins `sh '…'` strings). */
function segments(text: string, start: number, end: number, quotesSplit: boolean): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let segStart = start;
  let quote: string | undefined;
  const push = (i: number) => { if (i > segStart) out.push({ start: segStart, end: i }); };
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    // A GitHub Actions expression is one opaque token: `${{ vars.X || 'y' }}` holds no shell operators.
    if (c === "$" && text.startsWith("${{", i)) {
      const close = text.indexOf("}}", i + 3);
      if (close !== -1 && close < end) { i = close + 1; continue; }
    }
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === "\\") {
      // A backslash-newline continues the command; anything else escapes one character.
      i++;
      continue;
    }
    if ((c === "'" || c === '"') && !quotesSplit) { quote = c; continue; }
    if (c === "#" && (i === start || /\s/.test(text[i - 1]!))) {
      // A comment runs to the end of the line.
      push(i);
      while (i < end && text[i] !== "\n") i++;
      segStart = i + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "$(") { push(i); i++; segStart = i + 1; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "(" || c === ")" || c === "`" || (quotesSplit && (c === "'" || c === '"'))) {
      push(i);
      segStart = i + 1;
    }
  }
  push(end);
  return out;
}

const unquote = (w: string) => w.replace(/^(['"])(.*)\1$/, "$2").replace(/\\\n/g, "");

/** Words of a segment with their offsets; a `\`-newline is whitespace. */
function words(text: string, start: number, end: number): { word: string; at: number }[] {
  const out: { word: string; at: number }[] = [];
  const re = /(?:\$\{\{[\s\S]*?\}\}|[^\s'"\\]|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\.)*")+/g;
  const slice = text.slice(start, end);
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    // A lone backslash or a backslash-newline is a line continuation, not a word.
    if (/^\\\s*$/.test(m[0])) continue;
    out.push({ word: m[0], at: start + m.index });
  }
  return out;
}

export function findCommands(text: string, start: number, end: number, options: { quotesSplit?: boolean } = {}): Command[] {
  const commands: Command[] = [];
  for (const seg of segments(text, start, end, options.quotesSplit ?? false)) {
    const ws = words(text, seg.start, seg.end).filter((w) => w.word !== "\\");
    let k = 0;
    while (k < ws.length && (WRAPPERS.has(ws[k]!.word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k]!.word) || (ws[k - 1]?.word === "sudo" && ws[k]!.word.startsWith("-")))) k++;
    const first = ws[k];
    if (!first) continue;
    const program = unquote(first.word).split("/").pop()!.replace(/^[@+-]+/, "");
    if (!/^[\w.-]+$/.test(program)) continue;
    const last = ws[ws.length - 1]!;
    // A Makefile recipe prefix (@corepack enable) stays in front of the command.
    const s = k === 0 ? first.at + (unquote(first.word).length - unquote(first.word).replace(/^[@+-]+/, "").length) : ws[0]!.at;
    commands.push({
      start: s,
      end: last.at + last.word.length,
      program,
      args: ws.slice(k + 1).map((w) => unquote(w.word)),
      words: ws.slice(k + 1).map((w) => ({ raw: w.word, at: w.at })),
      text: text.slice(s, last.at + last.word.length).replace(/\\\n\s*/g, " "),
    });
  }
  return commands;
}

const GLOBAL = /^(?:-g|--global|--location=global)$/;

/** Packages a command installs globally: `npm i -g corepack@0.36.0` -> ["corepack"]. */
export function globalInstalls(c: Command): string[] {
  const a = c.args;
  const names = (list: string[]) => list.filter((x) => !x.startsWith("-")).map((x) => x.replace(/^(@?[^@]+)@.*$/, "$1"));
  if (c.program === "npm" && /^(?:i|install|add|in|isntall)$/.test(a[0] ?? "") && a.some((x) => GLOBAL.test(x))) return names(a.slice(1));
  if (c.program === "pnpm" && a[0] === "add" && a.some((x) => GLOBAL.test(x))) return names(a.slice(1));
  if (c.program === "yarn" && a[0] === "global" && a[1] === "add") return names(a.slice(2));
  if (c.program === "bun" && /^(?:add|install|i)$/.test(a[0] ?? "") && a.some((x) => GLOBAL.test(x))) return names(a.slice(1));
  if ((c.program === "apk" && a[0] === "add") || ((c.program === "apt-get" || c.program === "apt") && a[0] === "install")) return names(a.slice(1));
  return [];
}

/** What a command makes available: a corepack binary, or pnpm / yarn shims. */
export function provides(c: Command): Set<"corepack" | "pnpm" | "yarn"> {
  const out = new Set<"corepack" | "pnpm" | "yarn">();
  for (const p of globalInstalls(c)) {
    if (p === "corepack" || p === "pnpm" || p === "yarn") out.add(p);
    if (p === "@pnpm/exe") out.add("pnpm");
  }
  if (c.program === "corepack" && (c.args[0] === "enable" || c.args[0] === "install")) {
    const which = c.args.slice(1).filter((x) => !x.startsWith("-"));
    if (which.length === 0 || which.includes("pnpm")) out.add("pnpm");
    if (which.length === 0 || which.includes("yarn")) out.add("yarn");
  }
  // The standalone installers: https://get.pnpm.io/install.sh and the Yarn tarball script.
  if ((c.program === "curl" || c.program === "wget") && c.text.includes("get.pnpm.io")) out.add("pnpm");
  if ((c.program === "curl" || c.program === "wget") && c.text.includes("yarnpkg.com/install.sh")) out.add("yarn");
  return out;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash"]);

/** The script of `bash -c '…'` (or `sh -euo pipefail -c "…"`) as a span inside its quotes. */
export function shellScript(c: Command): { start: number; end: number } | undefined {
  if (!SHELLS.has(c.program)) return undefined;
  const i = c.words.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.raw));
  const script = i === -1 ? undefined : c.words[i + 1];
  if (!script || !/^(['"]).*\1$/s.test(script.raw)) return undefined;
  return { start: script.at + 1, end: script.at + script.raw.length - 1 };
}

/** docker run / create / exec options that take a separate value (`-e X`, `--name X`). */
const DOCKER_VALUE_OPTS = new Set([
  "-e", "--env", "-v", "--volume", "-w", "--workdir", "-p", "--publish", "-u", "--user", "--name", "--network", "--entrypoint",
  "--platform", "--mount", "--env-file", "-l", "--label", "--add-host", "--cpus", "-m", "--memory", "-h", "--hostname", "--ipc",
  "--pull", "--shm-size", "--cap-add", "--device", "--gpus", "--tmpfs", "--ulimit", "--security-opt",
]);

/**
 * `docker run [options] IMAGE [command…]`: the image word and the command words after it. For `docker exec` the
 * first positional is a container, not an image, so only the command is returned.
 */
export function dockerRun(c: Command): { image?: { raw: string; at: number }; rest: { raw: string; at: number }[] } | undefined {
  if (c.program !== "docker" && c.program !== "podman") return undefined;
  let w = c.words;
  if (w[0]?.raw === "container") w = w.slice(1);
  const sub = w[0]?.raw;
  if (sub !== "run" && sub !== "create" && sub !== "exec") return undefined;
  let i = 1;
  while (i < w.length && w[i]!.raw.startsWith("-")) i += DOCKER_VALUE_OPTS.has(w[i]!.raw) ? 2 : 1;
  const first = w[i];
  if (!first) return undefined;
  return sub === "exec" ? { rest: w.slice(i + 1) } : { image: first, rest: w.slice(i + 1) };
}
