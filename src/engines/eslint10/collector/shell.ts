/**
 * Just enough shell parsing to find the `eslint ...` command inside an npm
 * script. No Node imports, so the static engine can use it in a browser.
 */

/** Split a command into words (quotes respected, no expansion). Operators come out as their own words. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  const flush = () => {
    if (has || current) words.push(current);
    current = "";
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      flush();
    } else if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      flush();
      words.push(ch + ch);
      i++;
    } else if (ch === ";" || ch === "|" || (ch === "&" && command[i + 1] !== ">" && !/\d?>$/.test(current))) {
      flush();
      words.push(ch);
    } else {
      current += ch;
      has = true;
    }
  }
  flush();
  return words;
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);
/** Wrappers that run the next word as the command. Their own flags (-y, --no-install, node --max-old-space-size=...) are skipped. */
const RUNNERS = new Set(["npx", "pnpm", "pnpx", "yarn", "bunx", "bun", "exec", "dlx", "run", "cross-env", "env", "dotenv", "node", "--"]);
/** Redirections end the argument list: `> out.txt`, `2>&1`, `&> log`, `< in`. */
const REDIRECT = /^(\d*>>?|&>>?|<|\d*>&\d*)/;

export interface EslintCommand {
  env: Record<string, string>;
  args: string[];
  /** Flags given to `node` itself before the eslint script (for example --max-old-space-size=8192). */
  nodeFlags: string[];
}

/** Finds the `eslint ...` segment of a script: env assignments before it, its arguments after it. */
export function findEslintCommand(command: string): EslintCommand | null {
  const segments: string[][] = [[]];
  for (const w of shellWords(command)) {
    if (SEPARATORS.has(w)) segments.push([]);
    else segments[segments.length - 1]?.push(w);
  }
  for (const seg of segments) {
    const env: Record<string, string> = {};
    const nodeFlags: string[] = [];
    let runner: string | null = null;
    let i = 0;
    for (; i < seg.length; i++) {
      const w = seg[i] as string;
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(w);
      if (assign && runner !== "node") env[assign[1] as string] = assign[2] as string;
      else if (RUNNERS.has(w)) runner = w;
      else if (runner && w.startsWith("-")) {
        if (runner === "node") nodeFlags.push(w);
      } else break;
    }
    const head = seg[i];
    if (head === "eslint" || head?.endsWith("/eslint") || head?.endsWith("/eslint.js") || head?.endsWith("/bin/eslint.js")) {
      const rest = seg.slice(i + 1);
      const cut = rest.findIndex((w) => REDIRECT.test(w));
      return { env, args: cut === -1 ? rest : rest.slice(0, cut), nodeFlags };
    }
  }
  return null;
}

/** Scripts that run eslint but are not the lint check (config printing, fixing). */
export function isAuxiliaryEslint(args: string[]): boolean {
  return args.some((a) => /^--(print-config|inspect-config|init|fix|fix-dry-run|env-info|help|version)(=|$)/.test(a) || a === "-h" || a === "-v");
}
