import { posix } from 'node:path';
import type { Finding, Mount, MountKind, PostgresTarget } from './model.js';

const OLD_DATA_PATH = '/var/lib/postgresql/data';
const NEW_VOLUME_PATH = '/var/lib/postgresql';

export function normalizePath(p: string): string {
  const n = posix.normalize(p.trim());
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

function isUnder(path: string, mountTarget: string): boolean {
  const p = normalizePath(path);
  const m = normalizePath(mountTarget);
  return p === m || p.startsWith(m === '/' ? '/' : `${m}/`);
}

/**
 * Mounts that can hold the cluster: the one PGDATA sits in, anything under /var/lib/postgresql, or a
 * path named like a data directory. Init scripts, config files and backup folders are not.
 */
function isDataMount(m: Mount, pgdata: string): boolean {
  const target = normalizePath(m.target);
  if (/^\/(docker-entrypoint-initdb\.d|etc|run|var\/run|tmp)(\/|$)/.test(target)) return false;
  return isUnder(pgdata, target) || isUnder(target, NEW_VOLUME_PATH) || /(^|\/)(pg_?data|data|postgres(ql)?)$/i.test(target);
}

/** The PGDATA the entrypoint of an 18+ official image will use. */
function effectivePgdata(t: PostgresTarget, major: number): string {
  return t.pgdata ? normalizePath(t.pgdata) : `/var/lib/postgresql/${major}/docker`;
}

function hasChecksumChoice(initdbArgs: string | null): boolean {
  return initdbArgs !== null && /(--no-data-checksums|--data-checksums|(^|\s)-k(\s|$))/.test(initdbArgs);
}

function where(t: PostgresTarget): Pick<Finding, 'file' | 'target' | 'image'> {
  return { file: t.file, target: t.name, image: t.image.raw };
}

function pgdataFixLine(t: PostgresTarget): string {
  switch (t.kind) {
    case 'compose':
      return 'add `PGDATA: /var/lib/postgresql/data` under `environment:` and keep the mount as it is';
    case 'kubernetes':
      return 'add `- name: PGDATA` / `value: /var/lib/postgresql/data` to the container `env:` and keep the volumeMount';
    case 'github-actions':
      return 'add `PGDATA: /var/lib/postgresql/data` to the service `env:`';
    case 'dockerfile':
      return 'add `ENV PGDATA=/var/lib/postgresql/data` after FROM';
    case 'helm-values':
      return 'set the env var PGDATA=/var/lib/postgresql/data in the chart values';
  }
}

function migrateSteps(previous: number | null): string[] {
  const from = previous === null ? 'the old major' : String(previous);
  return [
    `dump and restore: while the ${from} container still runs, \`pg_dumpall -U <user> > backup.sql\` inside it; start the 18 image on a new, empty volume; then \`psql -U <user> -f backup.sql\``,
    'or run pg_upgrade in place with the pgautoupgrade/pgautoupgrade image (or tianon/postgres-upgrade) against a copy of the volume',
  ];
}

const MOUNT_LABEL: Record<MountKind, string> = {
  'named-volume': 'named volume',
  bind: 'bind mount',
  anonymous: 'volume',
  tmpfs: 'tmpfs',
  pvc: 'PersistentVolumeClaim',
  'host-path': 'hostPath volume',
  'empty-dir': 'emptyDir volume',
  other: 'volume',
};

function unsureNote(t: PostgresTarget): string {
  return t.kind === 'helm-values'
    ? ' The chart templates may set PGDATA; check the rendered manifest (helm template).'
    : ' PGDATA may be set in a file or ConfigMap this tool cannot read; check it.';
}

function dataMount(t: PostgresTarget, major: number, mount: Mount): Finding {
  const unsure = t.pgdataUnknown;
  const fix = [
    `keep the old layout: ${pgdataFixLine(t)}`,
    (t.kind === 'dockerfile'
      ? `or use the 18 layout: drop this VOLUME line, the base image already declares VOLUME ${NEW_VOLUME_PATH}`
      : `or use the 18 layout: mount the volume at ${NEW_VOLUME_PATH} instead of ${OLD_DATA_PATH}`) +
      (mount.persistent && !t.ephemeral ? '; data already in the volume has to be dumped and restored, or pg_upgraded, first' : ''),
  ];
  return {
    rule: 'data-mount',
    severity: unsure ? 'warning' : 'error',
    ...where(t),
    line: mount.line,
    message:
      `${t.image.raw} keeps its data in /var/lib/postgresql/${major}/docker, but a ${MOUNT_LABEL[mount.kind]} is mounted at ${OLD_DATA_PATH}. ` +
      'On a first start the entrypoint sees that mount and exits before initdb ' +
      '("Error: in 18+, these Docker images are configured to store database data in a format which is compatible with pg_ctlcluster ...").' +
      (unsure ? unsureNote(t) : ''),
    fix,
  };
}

/** Applies the rules to one Postgres container. Returns no findings for a correct 18 setup. */
export function evaluate(t: PostgresTarget): Finding[] {
  const out: Finding[] = [];
  const { image } = t;

  if (image.layout === 'other') {
    out.push({
      rule: 'skipped-image',
      severity: 'info',
      ...where(t),
      line: t.line,
      message: `${image.repository} uses its own data layout, not the official image's; these rules do not apply to it.`,
      fix: [],
    });
    return out;
  }
  if (image.layout === 'upgrade-tool' || image.major === null || image.major < 18) return out;

  const major = image.major;
  const pgdata = effectivePgdata(t, major);
  const persistentMounts = t.mounts.filter((m) => m.persistent && isDataMount(m, pgdata));
  const oldPathMount = t.mounts.find((m) => normalizePath(m.target) === OLD_DATA_PATH);
  const defaultPgdata = pgdata === `/var/lib/postgresql/${major}/docker`;

  if (oldPathMount && defaultPgdata) out.push(dataMount(t, major, oldPathMount));

  const previous = t.previousMajor;
  const bumped = previous !== null && previous < major;
  const holdsOldData = !t.ephemeral && persistentMounts.length > 0;

  const realUpgrade = t.upgradeStep !== null && /upgrade/i.test(t.upgradeStep);
  if (bumped && holdsOldData && !realUpgrade) {
    const mount = persistentMounts[0];
    const onlyDump = t.upgradeStep !== null;
    out.push({
      rule: 'major-bump',
      severity: onlyDump ? 'warning' : 'error',
      ...where(t),
      line: t.line,
      message:
        `This change moves ${t.name} from Postgres ${previous} to ${major} on an existing ${mount ? MOUNT_LABEL[mount.kind] : 'volume'}` +
        `${mount?.source ? ` (${mount.source})` : ''}. Postgres ${major} cannot open data files written by ${previous}: ` +
        '"FATAL: database files are incompatible with server". ' +
        (onlyDump
          ? `There is a dump step (${t.upgradeStep ?? ''}); make sure a fresh dump is restored into a new, empty volume.`
          : 'No upgrade step was found next to it.'),
      fix: migrateSteps(previous),
    });
  }

  const usesPgUpgrade = t.upgradeStep === null || /upgrade/i.test(t.upgradeStep);
  if (bumped && holdsOldData && usesPgUpgrade && !hasChecksumChoice(t.initdbArgs)) {
    out.push({
      rule: 'checksums',
      severity: 'warning',
      ...where(t),
      line: t.line,
      message:
        `initdb in Postgres 18 turns data checksums on by default; a cluster created by ${previous} with default settings has them off. ` +
        'pg_upgrade then stops with "old cluster does not use data checksums but the new one does".',
      fix: [
        'check the old cluster first: `SHOW data_checksums;` (or run sql/preflight.sql)',
        'if it says off, create the 18 cluster with POSTGRES_INITDB_ARGS="--no-data-checksums" (or enable checksums on the old one with pg_checksums --enable while it is stopped)',
        'a dump/restore upgrade does not care about this setting',
      ],
    });
  }

  if (image.floating && holdsOldData && previous === null) {
    out.push({
      rule: 'floating-tag',
      severity: 'warning',
      ...where(t),
      line: t.line,
      message:
        `${image.raw} follows the newest major, which has been 18 since PostgreSQL 18 came out in September 2025. A volume created before that holds 17 or older data, ` +
        'and the next pull starts 18 on it.',
      fix: ['pin the major you actually run, e.g. `postgres:17`, and upgrade on purpose'],
    });
  }

  if (!t.ephemeral && persistentMounts.length > 0 && !t.pgdataUnknown && !persistentMounts.some((m) => isUnder(pgdata, m.target))) {
    const alreadyReported = oldPathMount !== undefined && defaultPgdata;
    if (!alreadyReported) {
      out.push({
        rule: 'pgdata-not-persisted',
        severity: 'warning',
        ...where(t),
        line: persistentMounts[0]?.line ?? t.line,
        message: `PGDATA is ${pgdata}, which is not inside any persistent mount (${persistentMounts.map((m) => m.target).join(', ')}). The data ends up in the image's anonymous volume and is lost when the container is recreated.`,
        fix: [`mount the volume at ${NEW_VOLUME_PATH}, or point PGDATA inside the mount you have`],
      });
    }
  }

  return out;
}
