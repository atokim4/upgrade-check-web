import { parseImage } from '../image.js';
import type { Mount, PostgresTarget } from '../model.js';
import { parseShortVolume } from './compose.js';
import { asString, isRecord, parseYaml, readEnvironment } from './util.js';

/** `--tmpfs /var/lib/postgresql/data` or `--mount type=tmpfs,destination=...` in service options. */
function mountsFromOptions(options: string, line: number): Mount[] {
  const mounts: Mount[] = [];
  for (const m of options.matchAll(/--tmpfs[=\s]+["']?([^\s:"']+)/g)) {
    if (m[1]) mounts.push({ target: m[1], kind: 'tmpfs', source: null, persistent: false, line });
  }
  for (const m of options.matchAll(/(?:-v|--volume)[=\s]+["']?([^\s"']+)/g)) {
    const parsed = m[1] ? parseShortVolume(m[1], line) : null;
    if (parsed) mounts.push(parsed);
  }
  for (const m of options.matchAll(/--mount[=\s]+["']?([^\s"']+)/g)) {
    const fields = new Map((m[1] ?? '').split(',').map((kv) => kv.split('=') as [string, string]));
    const target = fields.get('target') ?? fields.get('destination') ?? fields.get('dst');
    if (target) mounts.push({ target, kind: fields.get('type') === 'tmpfs' ? 'tmpfs' : 'other', source: fields.get('source') ?? null, persistent: false, line });
  }
  return mounts;
}

/**
 * Service and job containers in a GitHub Actions workflow. They start empty on every run,
 * so only the mount layout matters, never the data in them.
 */
export function actionsTargets(file: string, text: string): PostgresTarget[] {
  const out: PostgresTarget[] = [];
  for (const y of parseYaml(text)) {
    if (!isRecord(y.value) || !isRecord(y.value.jobs)) continue;
    for (const [jobId, job] of Object.entries(y.value.jobs)) {
      if (!isRecord(job)) continue;
      const containers: Array<[string, unknown, Array<string | number>]> = [];
      if (isRecord(job.services)) {
        for (const [svc, def] of Object.entries(job.services)) containers.push([`${jobId}/services/${svc}`, def, ['jobs', jobId, 'services', svc]]);
      }
      if (job.container !== undefined) containers.push([`${jobId}/container`, job.container, ['jobs', jobId, 'container']]);

      for (const [name, def, path] of containers) {
        const imageRef = typeof def === 'string' ? def : isRecord(def) ? asString(def.image) : null;
        if (imageRef === null || imageRef.includes('${{')) continue;
        const image = parseImage(imageRef);
        if (!image) continue;
        const env = isRecord(def) ? readEnvironment(def.env) : new Map<string, string>();
        const mounts: Mount[] = [];
        if (isRecord(def)) {
          if (Array.isArray(def.volumes)) {
            def.volumes.forEach((v, i) => {
              const s = asString(v);
              const m = s === null ? null : parseShortVolume(s, y.lineOf([...path, 'volumes', i]));
              if (m) mounts.push({ ...m, persistent: false });
            });
          }
          const options = asString(def.options);
          if (options) mounts.push(...mountsFromOptions(options, y.lineOf([...path, 'options'])));
        }
        out.push({
          file,
          kind: 'github-actions',
          name,
          image,
          line: y.lineOf(typeof def === 'string' ? path : [...path, 'image']),
          pgdata: env.get('PGDATA') ?? null,
          pgdataUnknown: false,
          initdbArgs: env.get('POSTGRES_INITDB_ARGS') ?? null,
          mounts,
          ephemeral: true,
          upgradeStep: null,
          previousMajor: null,
        });
      }
    }
  }
  return out;
}
