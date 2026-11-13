import { posix } from 'node:path';
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

/** The chart folder name, for an image set at the top level of a values file. */
function chartName(file: string): string {
  const dir = posix.basename(posix.dirname(file));
  return dir === '.' || dir === '' ? 'values' : dir;
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
    name: path.slice(0, -1).join('.') || chartName(file),
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

export interface ChartTemplate {
  file: string;
  text: string;
}

const TEMPLATE_MOUNT = /^\s*-?\s*mountPath:\s*["']?(\/var\/lib\/postgresql[^\s"'#]*)/;

/** True for a Go-template YAML file in a chart's `templates/` folder, which a YAML parser cannot read. */
export function isHelmTemplate(file: string, text: string): boolean {
  return /(^|\/)templates\/.+\.ya?ml$/.test(file) && text.includes('{{');
}

/**
 * Chart templates are not rendered, so this reads them as text: a `mountPath` under
 * /var/lib/postgresql becomes a mount of the chart's values target, unless PGDATA is set
 * anywhere in the templates.
 */
export function applyTemplateMounts(target: PostgresTarget, templates: ChartTemplate[]): void {
  if (target.mounts.length > 0) return;
  if (templates.some((t) => /\bPGDATA\b/.test(t.text))) return;
  for (const { file, text } of templates) {
    text.split('\n').forEach((line, i) => {
      const m = TEMPLATE_MOUNT.exec(line);
      if (m?.[1]) target.mounts.push({ target: m[1], kind: 'other', source: null, persistent: true, line: i + 1, file });
    });
  }
}
