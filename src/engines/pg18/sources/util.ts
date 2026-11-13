import { LineCounter, parseAllDocuments, type Document, type Node } from 'yaml';

/** Read access to one version of the repository (working tree or a git ref). */
export interface Snapshot {
  /** Returns the file contents, or null when the file does not exist in this snapshot. */
  read(relPath: string): string | null;
}

export interface YamlDoc {
  doc: Document.Parsed;
  value: unknown;
  lineOf(path: ReadonlyArray<string | number>): number;
}

/** Parses every document in a YAML stream. Documents with syntax errors are skipped. */
export function parseYaml(text: string): YamlDoc[] {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc, uniqueKeys: false });
  if (!Array.isArray(docs)) return [];
  return docs
    .filter((d) => d.errors.length === 0)
    .map((doc) => ({
      doc,
      value: doc.toJS({ maxAliasCount: 1000 }) as unknown,
      lineOf(path: ReadonlyArray<string | number>): number {
        for (let n = path.length; n >= 0; n--) {
          const node = doc.getIn(path.slice(0, n), true) as Node | undefined;
          const offset = node?.range?.[0];
          if (offset !== undefined) return lc.linePos(offset).line;
        }
        return 1;
      },
    }));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Parses a dotenv file: KEY=VALUE lines, optional `export`, quotes, `#` comments. */
export function parseDotenv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = m[2] ?? '';
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    vars.set(m[1], value);
  }
  return vars;
}

/**
 * Compose-style interpolation: $VAR, ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, $$.
 * Unknown variables without a default are left as they are, so callers can tell they are unresolved.
 */
export function interpolate(input: string, vars: ReadonlyMap<string, string>): string {
  return input.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced: string | undefined, op: string | undefined, arg: string | undefined, bare: string | undefined) => {
      if (whole === '$$') return '$';
      const name = braced ?? bare ?? '';
      const value = vars.get(name);
      if (value === undefined || (op?.startsWith(':') === true && value === '')) {
        if (op === ':-' || op === '-') return interpolate(arg ?? '', vars);
        if (op === ':+' || op === '+') return '';
        return whole;
      }
      return op === ':+' || op === '+' ? interpolate(arg ?? '', vars) : value;
    });
}

/** Reads `environment:` in either list (`- KEY=VALUE`) or map form. */
export function readEnvironment(v: unknown): Map<string, string> {
  const env = new Map<string, string>();
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = asString(item);
      if (s === null) continue;
      const eq = s.indexOf('=');
      if (eq > 0) env.set(s.slice(0, eq), s.slice(eq + 1));
    }
  } else if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) {
      const s = asString(val);
      if (s !== null) env.set(k, s);
    }
  }
  return env;
}

export function joinPath(dir: string, rel: string): string {
  const parts: string[] = [];
  for (const seg of `${dir}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function dirname(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}
