/**
 * Parses container image references and works out the Postgres major version they run.
 *
 * Only images built on the official docker-library `postgres` image share its PGDATA and
 * VOLUME layout, so only those get a `layout: 'official'`. Images with their own layout
 * (bitnami, timescaledb-ha, supabase...) are recognised so they can be reported as skipped.
 */

export type Layout = 'official' | 'other' | 'upgrade-tool';

export interface ImageInfo {
  raw: string;
  /** Repository path without registry, e.g. `postgres`, `postgis/postgis`. */
  repository: string;
  tag: string | null;
  family: string;
  layout: Layout;
  /** Postgres major the tag runs, when it can be read from the tag. */
  major: number | null;
  /** True when the tag moves between majors over time (`latest`, `alpine`, no tag). */
  floating: boolean;
}

/** Major the floating `postgres:latest` tag points to (docker-library/official-images, 2026-11). */
export const LATEST_OFFICIAL_MAJOR = 18;

const OFFICIAL_FLOATING_TAGS = /^(latest|alpine[\d.]*|bookworm|bullseye|trixie)$/;

const KNOWN: ReadonlyArray<{ match: RegExp; family: string; layout: Layout; major: (tag: string) => number | null }> = [
  { match: /^postgres$/, family: 'postgres', layout: 'official', major: (t) => leadingMajor(t) },
  { match: /^postgis\/postgis$/, family: 'postgis', layout: 'official', major: (t) => leadingMajor(t) },
  { match: /^pgvector\/pgvector$/, family: 'pgvector', layout: 'official', major: (t) => pgSuffixMajor(t) },
  { match: /^timescale\/timescaledb$/, family: 'timescaledb', layout: 'official', major: (t) => pgSuffixMajor(t) },
  { match: /^pgautoupgrade\/pgautoupgrade$/, family: 'pgautoupgrade', layout: 'upgrade-tool', major: (t) => leadingMajor(t) },
  { match: /^tianon\/postgres-upgrade$/, family: 'postgres-upgrade', layout: 'upgrade-tool', major: (t) => toMajor(t) },
  { match: /^bitnami\/postgresql(-repmgr)?$/, family: 'bitnami', layout: 'other', major: (t) => leadingMajor(t) },
  { match: /^timescale\/timescaledb-ha$/, family: 'timescaledb-ha', layout: 'other', major: (t) => pgSuffixMajor(t) },
  { match: /^supabase\/postgres$/, family: 'supabase', layout: 'other', major: (t) => leadingMajor(t) },
  { match: /^cloudnative-pg\/postgresql$/, family: 'cloudnative-pg', layout: 'other', major: (t) => leadingMajor(t) },
];

function leadingMajor(tag: string): number | null {
  const m = /^(\d+)/.exec(tag);
  return m?.[1] ? Number(m[1]) : null;
}

function pgSuffixMajor(tag: string): number | null {
  const m = /(?:^|-)pg(\d+)/.exec(tag);
  return m?.[1] ? Number(m[1]) : null;
}

/** `tianon/postgres-upgrade:14-to-18` → 18. */
function toMajor(tag: string): number | null {
  const m = /-to-(\d+)/.exec(tag);
  return m?.[1] ? Number(m[1]) : null;
}

/** Splits `registry/path/name:tag@digest` and drops the registry and `library/` prefix. */
function splitReference(ref: string): { repository: string; tag: string | null } {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const parts = withoutDigest.split('/');
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    parts.shift();
  }
  // public.ecr.aws/docker/library/postgres
  if (parts[0] === 'docker' && parts[1] === 'library') parts.splice(0, 2);
  if (parts[0] === 'library') parts.shift();
  const last = parts.pop() ?? '';
  const colon = last.lastIndexOf(':');
  const name = colon === -1 ? last : last.slice(0, colon);
  const tag = colon === -1 ? null : last.slice(colon + 1);
  return { repository: [...parts, name].join('/').toLowerCase(), tag };
}

/** Returns null when the reference is not a Postgres image we know about. */
export function parseImage(raw: string): ImageInfo | null {
  const ref = raw.trim();
  if (ref === '' || ref.includes('$')) return null;
  const { repository, tag } = splitReference(ref);
  const known = KNOWN.find((k) => k.match.test(repository));
  if (!known) return null;
  const pinnedByDigest = ref.includes('@') && tag === null;
  let major = tag === null ? null : known.major(tag);
  let floating = false;
  if (known.family === 'postgres' && !pinnedByDigest && (tag === null || OFFICIAL_FLOATING_TAGS.test(tag))) {
    major = LATEST_OFFICIAL_MAJOR;
    floating = true;
  }
  return { raw: ref, repository, tag, family: known.family, layout: known.layout, major, floating };
}
