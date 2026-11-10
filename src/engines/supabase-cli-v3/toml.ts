// Just enough TOML for supabase/config.toml: table headers and `key = value` lines, with offsets. The rules only
// look at section names and a few scalar keys, so arrays, inline tables and multi-line strings are skipped over.

export interface TomlHeader {
  /** Dotted table name without brackets, quotes removed: `remotes.production.inbucket`. */
  name: string;
  array: boolean;
  line: number;
  /** Offsets of the name inside the brackets, for renaming it in place. */
  nameStart: number;
  nameEnd: number;
}

export interface TomlKey {
  /** The table the key belongs to ("" at the root). */
  table: string;
  key: string;
  /** Raw value text, comment stripped. */
  value: string;
  line: number;
  keyStart: number;
  keyEnd: number;
}

export interface TomlDoc {
  headers: TomlHeader[];
  keys: TomlKey[];
}

export function parseToml(text: string): TomlDoc {
  const headers: TomlHeader[] = [];
  const keys: TomlKey[] = [];
  let table = "";
  let offset = 0;
  let multiline: string | null = null;
  text.split("\n").forEach((raw, i) => {
    const lineStart = offset;
    offset += raw.length + 1;
    if (multiline) {
      if (raw.includes(multiline)) multiline = null;
      return;
    }
    const header = /^(\s*)(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(raw);
    if (header) {
      const nameStart = lineStart + raw.indexOf(header[3]!, header[1]!.length + header[2]!.length);
      table = header[3]!.split(".").map((p) => p.trim().replace(/^"(.*)"$/, "$1")).join(".");
      headers.push({ name: table, array: header[2] === "[[", line: i + 1, nameStart, nameEnd: nameStart + header[3]!.length });
      return;
    }
    const kv = /^(\s*)([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/.exec(raw);
    if (!kv) return;
    const value = stripComment(kv[3]!);
    if (/^("""|''')/.test(value) && !value.slice(3).includes(value.slice(0, 3))) multiline = value.slice(0, 3);
    const keyStart = lineStart + kv[1]!.length;
    keys.push({ table, key: kv[2]!.replace(/^"(.*)"$/, "$1"), value, line: i + 1, keyStart, keyEnd: keyStart + kv[2]!.length });
  });
  return { headers, keys };
}

function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return value.slice(0, i).trim();
  }
  return value.trim();
}

/** A scalar's value without quotes. */
export const unquote = (v: string) => v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
