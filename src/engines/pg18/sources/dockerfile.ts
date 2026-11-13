import { parseImage } from '../image.js';
import type { Mount, PostgresTarget } from '../model.js';

export interface DockerfileInfo {
  /** Base image of the final stage, ARG defaults substituted. */
  from: string | null;
  fromLine: number;
  stage: string | null;
  env: Map<string, string>;
  volumes: Array<{ path: string; line: number }>;
}

interface Instruction {
  keyword: string;
  args: string;
  line: number;
}

function instructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split(/\r?\n/);
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (buf === '' && /^\s*(#|$)/.test(line)) continue;
    if (buf === '') start = i + 1;
    if (/\\\s*$/.test(line)) {
      buf += line.replace(/\\\s*$/, ' ');
      continue;
    }
    buf += line;
    const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(buf);
    if (m?.[1]) out.push({ keyword: m[1].toUpperCase(), args: (m[2] ?? '').trim(), line: start });
    buf = '';
  }
  return out;
}

function substitute(s: string, args: ReadonlyMap<string, string>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, a: string | undefined, def: string | undefined, b: string | undefined) => args.get(a ?? b ?? '') ?? def ?? whole);
}

function unquote(s: string): string {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

/** ENV KEY=VALUE [KEY2=VALUE2...] or the legacy ENV KEY VALUE form. */
function parseEnv(args: string): Array<[string, string]> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(args)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(args);
    return m?.[1] ? [[m[1], unquote((m[2] ?? '').trim())]] : [];
  }
  const pairs: Array<[string, string]> = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g;
  for (const m of args.matchAll(re)) if (m[1]) pairs.push([m[1], unquote(m[2] ?? '')]);
  return pairs;
}

function parseVolume(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(/\s+/).map(unquote).filter(Boolean);
}

export function parseDockerfile(text: string): DockerfileInfo {
  const globalArgs = new Map<string, string>();
  let info: DockerfileInfo = { from: null, fromLine: 1, stage: null, env: new Map(), volumes: [] };
  let seenFrom = false;
  let stageArgs = new Map<string, string>();
  for (const ins of instructions(text)) {
    if (ins.keyword === 'ARG') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(ins.args);
      if (m?.[1] && m[2] !== undefined) (seenFrom ? stageArgs : globalArgs).set(m[1], unquote(m[2]));
    } else if (ins.keyword === 'FROM') {
      seenFrom = true;
      stageArgs = new Map();
      const tokens = ins.args.split(/\s+/).filter((tok) => !tok.startsWith('--'));
      const image = substitute(tokens[0] ?? '', globalArgs);
      const stage = tokens[1]?.toUpperCase() === 'AS' ? (tokens[2] ?? null) : null;
      info = { from: image, fromLine: ins.line, stage, env: new Map(), volumes: [] };
    } else if (ins.keyword === 'ENV') {
      const scope = new Map([...globalArgs, ...stageArgs, ...info.env]);
      for (const [k, v] of parseEnv(ins.args)) info.env.set(k, substitute(v, scope));
    } else if (ins.keyword === 'VOLUME') {
      for (const path of parseVolume(ins.args)) info.volumes.push({ path, line: ins.line });
    }
  }
  return info;
}

/** A Dockerfile whose final stage is a Postgres image. */
export function dockerfileTargets(file: string, text: string): PostgresTarget[] {
  const info = parseDockerfile(text);
  const image = info.from ? parseImage(info.from) : null;
  if (!image) return [];
  const mounts: Mount[] = info.volumes.map((v) => ({ target: v.path, kind: 'anonymous', source: null, persistent: true, line: v.line }));
  return [
    {
      file,
      kind: 'dockerfile',
      name: info.stage ?? 'final stage',
      image,
      line: info.fromLine,
      pgdata: info.env.get('PGDATA') ?? null,
      pgdataUnknown: false,
      initdbArgs: info.env.get('POSTGRES_INITDB_ARGS') ?? null,
      mounts,
      ephemeral: false,
      upgradeStep: null,
      previousMajor: null,
    },
  ];
}
