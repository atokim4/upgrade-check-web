import { parseImage, type ImageInfo } from '../image.js';
import type { Mount, PostgresTarget } from '../model.js';
import { parseDockerfile } from './dockerfile.js';
import { asString, dirname, interpolate, isRecord, joinPath, parseDotenv, parseYaml, readEnvironment, type Snapshot, type YamlDoc } from './util.js';

const UPGRADE_HINT = /pgautoupgrade|postgres-upgrade|pg_upgrade|pg_dumpall|pg_dump\b|pg_restore/;

/** Parses a short volume spec: `src:target[:mode]`, or just `target` for an anonymous volume. */
export function parseShortVolume(spec: string, line: number): Mount | null {
  const parts = spec.split(':');
  // Windows drive letters (C:\data:/var/lib/...) keep their colon.
  if (parts.length >= 3 && /^[A-Za-z]$/.test(parts[0] ?? '') && /^[\\/]/.test(parts[1] ?? '')) {
    parts.splice(0, 2, `${parts[0] ?? ''}:${parts[1] ?? ''}`);
  }
  if (parts.length === 1) {
    const target = parts[0] ?? '';
    return target.startsWith('/') ? { target, kind: 'anonymous', source: null, persistent: true, line } : null;
  }
  const source = parts[0] ?? '';
  const target = parts[1] ?? '';
  if (!target.startsWith('/')) return null;
  const bind = /^([./~]|[A-Za-z]:[\\/]|\$)/.test(source);
  return { target, kind: bind ? 'bind' : 'named-volume', source, persistent: true, line };
}

function readMounts(service: Record<string, unknown>, y: YamlDoc, base: ReadonlyArray<string | number>, vars: ReadonlyMap<string, string>): Mount[] {
  const mounts: Mount[] = [];
  const volumes = service.volumes;
  if (Array.isArray(volumes)) {
    volumes.forEach((v, i) => {
      const line = y.lineOf([...base, 'volumes', i]);
      const s = asString(v);
      if (s !== null) {
        const m = parseShortVolume(interpolate(s, vars), line);
        if (m) mounts.push(m);
      } else if (isRecord(v)) {
        const target = asString(v.target);
        if (!target) return;
        const type = asString(v.type) ?? 'volume';
        const source = asString(v.source);
        const kind = type === 'bind' ? 'bind' : type === 'tmpfs' ? 'tmpfs' : type === 'volume' ? (source ? 'named-volume' : 'anonymous') : 'other';
        mounts.push({ target: interpolate(target, vars), kind, source, persistent: kind !== 'tmpfs', line });
      }
    });
  }
  const tmpfs = service.tmpfs;
  const tmpfsList = Array.isArray(tmpfs) ? tmpfs : tmpfs === undefined ? [] : [tmpfs];
  tmpfsList.forEach((t, i) => {
    const s = asString(t);
    const target = s?.split(':')[0];
    if (target?.startsWith('/')) {
      mounts.push({ target, kind: 'tmpfs', source: null, persistent: false, line: y.lineOf([...base, 'tmpfs', Array.isArray(tmpfs) ? i : 0]) });
    }
  });
  return mounts;
}

interface BuildInfo {
  image: ImageInfo | null;
  env: Map<string, string>;
  volumes: string[];
}

function readBuild(build: unknown, composeDir: string, snap: Snapshot): BuildInfo | null {
  if (typeof build !== 'string' && !isRecord(build)) return null;
  const context = typeof build === 'string' ? build : (asString(build.context) ?? '.');
  const dockerfile = typeof build === 'string' ? 'Dockerfile' : (asString(build.dockerfile) ?? 'Dockerfile');
  if (/^[a-z]+:\/\//.test(context)) return null;
  const text = snap.read(joinPath(joinPath(composeDir, context), dockerfile));
  if (text === null) return null;
  const info = parseDockerfile(text);
  return { image: info.from ? parseImage(info.from) : null, env: info.env, volumes: info.volumes.map((v) => v.path) };
}

/** Finds Postgres services in a docker compose file. */
export function composeTargets(file: string, text: string, snap: Snapshot): PostgresTarget[] {
  const dir = dirname(file);
  const dotenv = snap.read(joinPath(dir, '.env'));
  const vars = dotenv === null ? new Map<string, string>() : parseDotenv(dotenv);
  const out: PostgresTarget[] = [];

  for (const y of parseYaml(text)) {
    if (!isRecord(y.value) || !isRecord(y.value.services)) continue;
    const services = y.value.services;
    const upgradeServices = Object.entries(services).flatMap(([name, s]) => {
      if (!isRecord(s)) return [];
      const hint = UPGRADE_HINT.exec(JSON.stringify([s.image, s.command, s.entrypoint]));
      return hint ? [{ name, step: `service "${name}" (${hint[0]})` }] : [];
    });

    for (const [name, raw] of Object.entries(services)) {
      if (!isRecord(raw)) continue;
      const base = ['services', name];
      const imageRef = asString(raw.image);
      const build = raw.build === undefined ? null : readBuild(raw.build, dir, snap);
      let image = imageRef === null ? null : parseImage(interpolate(imageRef, vars));
      if (build?.image) image = build.image;
      if (!image) continue;

      const ownEnv = readEnvironment(raw.environment);
      const env = new Map([...(build?.env ?? []), ...ownEnv]);
      let pgdataUnknown = false;
      const envFiles = raw.env_file === undefined ? [] : Array.isArray(raw.env_file) ? raw.env_file : [raw.env_file];
      for (const ef of envFiles) {
        const path = asString(ef) ?? (isRecord(ef) ? asString(ef.path) : null);
        if (!path) continue;
        const content = snap.read(joinPath(dir, path));
        if (content === null) {
          pgdataUnknown = true;
          continue;
        }
        for (const [k, v] of parseDotenv(content)) if (!ownEnv.has(k)) env.set(k, v);
      }
      const resolve = (v: string | undefined): string | null => (v === undefined ? null : interpolate(v, vars));

      const mounts = readMounts(raw, y, base, vars);
      for (const v of build?.volumes ?? []) {
        if (!mounts.some((m) => m.target === v)) mounts.push({ target: v, kind: 'anonymous', source: null, persistent: true, line: y.lineOf([...base, 'build']) });
      }
      const ownCommand = JSON.stringify([raw.command, raw.entrypoint]);
      const ownHint = UPGRADE_HINT.exec(ownCommand);
      const upgradeStep = image.layout === 'upgrade-tool' ? image.repository
        : ownHint ? `command (${ownHint[0]})`
        : upgradeServices.find((s) => s.name !== name)?.step ?? null;

      out.push({
        file,
        kind: 'compose',
        name,
        image,
        line: y.lineOf([...base, raw.image === undefined ? 'build' : 'image']),
        pgdata: resolve(env.get('PGDATA')),
        pgdataUnknown,
        initdbArgs: resolve(env.get('POSTGRES_INITDB_ARGS')),
        mounts,
        ephemeral: false,
        upgradeStep,
        previousMajor: null,
      });
    }
  }
  return out;
}
