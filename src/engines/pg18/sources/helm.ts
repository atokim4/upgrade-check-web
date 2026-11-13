import { parseImage, type ImageInfo } from '../image.js';
import type { Mount, PostgresTarget } from '../model.js';
import { asString, isRecord, parseYaml, type YamlDoc } from './util.js';

type Path = Array<string | number>;

const MOUNT_KEYS = /^(mountPath|path|dataDir|dataDirectory|mountpath)$/;

interface Found {
  image: ImageInfo;
  path: Path;
}

function imageFrom(v: unknown): ImageInfo | null {
  const s = asString(v);
  if (s !== null) return parseImage(s);
  if (!isRecord(v)) return null;
  const repo = asString(v.repository) ?? asString(v.name);
  if (!repo) return null;
  const registry = asString(v.registry);
  const tag = asString(v.tag);
  return parseImage(`${registry ? `${registry}/` : ''}${repo}${tag ? `:${tag}` : ''}`);
}

function walk(v: unknown, path: Path, visit: (key: string | number, value: unknown, path: Path) => void): void {
  if (Array.isArray(v)) v.forEach((item, i) => { visit(i, item, [...path, i]); walk(item, [...path, i], visit); });
  else if (isRecord(v)) for (const [k, item] of Object.entries(v)) { visit(k, item, [...path, k]); walk(item, [...path, k], visit); }
}

function docTargets(file: string, y: YamlDoc): PostgresTarget[] {
  const images: Found[] = [];
  const mounts: Mount[] = [];
  let pgdataSet = false;
  walk(y.value, [], (key, value, path) => {
    if (key === 'image') {
      const image = imageFrom(value);
      if (image) images.push({ image, path });
    }
    if (typeof key === 'string' && MOUNT_KEYS.test(key)) {
      const target = asString(value);
      if (target?.startsWith('/var/lib/postgresql')) mounts.push({ target, kind: 'other', source: null, persistent: true, line: y.lineOf(path) });
    }
    if (key === 'PGDATA' || (isRecord(value) && value.name === 'PGDATA')) pgdataSet = true;
  });
  return images.map(({ image, path }) => ({
    file,
    kind: 'helm-values' as const,
    name: path.slice(0, -1).join('.') || 'values',
    image,
    line: y.lineOf(path),
    pgdata: null,
    // Chart templates decide the real env and mounts; treat what we see as a hint.
    pgdataUnknown: true,
    initdbArgs: null,
    mounts: pgdataSet ? [] : mounts,
    ephemeral: false,
    upgradeStep: null,
    previousMajor: null,
  }));
}

/** Postgres images in Helm values files. Findings here are warnings, the templates are not rendered. */
export function helmTargets(file: string, text: string): PostgresTarget[] {
  return parseYaml(text).flatMap((y) => docTargets(file, y));
}
