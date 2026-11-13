import { parseImage } from '../image.js';
import type { Mount, MountKind, PostgresTarget } from '../model.js';
import { asString, isRecord, parseYaml, type YamlDoc } from './util.js';

type Path = Array<string | number>;

const WORKLOADS = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']);

/** Returns the pod spec and its YAML path for a workload object. */
function podSpec(obj: Record<string, unknown>): { spec: Record<string, unknown>; path: Path } | null {
  const kind = asString(obj.kind);
  if (!kind || !WORKLOADS.has(kind)) return null;
  const spec = obj.spec;
  if (!isRecord(spec)) return null;
  if (kind === 'Pod') return { spec, path: ['spec'] };
  if (kind === 'CronJob') {
    const jt = isRecord(spec.jobTemplate) ? spec.jobTemplate : null;
    const js = jt && isRecord(jt.spec) ? jt.spec : null;
    const tpl = js && isRecord(js.template) ? js.template : null;
    return tpl && isRecord(tpl.spec) ? { spec: tpl.spec, path: ['spec', 'jobTemplate', 'spec', 'template', 'spec'] } : null;
  }
  const tpl = isRecord(spec.template) ? spec.template : null;
  return tpl && isRecord(tpl.spec) ? { spec: tpl.spec, path: ['spec', 'template', 'spec'] } : null;
}

function volumeKinds(obj: Record<string, unknown>, spec: Record<string, unknown>): Map<string, { kind: MountKind; source: string | null }> {
  const kinds = new Map<string, { kind: MountKind; source: string | null }>();
  if (Array.isArray(spec.volumes)) {
    for (const v of spec.volumes) {
      if (!isRecord(v)) continue;
      const name = asString(v.name);
      if (!name) continue;
      if (isRecord(v.persistentVolumeClaim)) kinds.set(name, { kind: 'pvc', source: asString(v.persistentVolumeClaim.claimName) });
      else if (isRecord(v.hostPath)) kinds.set(name, { kind: 'host-path', source: asString(v.hostPath.path) });
      else if (isRecord(v.emptyDir)) kinds.set(name, { kind: 'empty-dir', source: null });
      else kinds.set(name, { kind: 'other', source: null });
    }
  }
  const objSpec = isRecord(obj.spec) ? obj.spec : {};
  if (Array.isArray(objSpec.volumeClaimTemplates)) {
    for (const t of objSpec.volumeClaimTemplates) {
      const name = isRecord(t) && isRecord(t.metadata) ? asString(t.metadata.name) : null;
      if (name) kinds.set(name, { kind: 'pvc', source: name });
    }
  }
  return kinds;
}

function containerTargets(file: string, y: YamlDoc, obj: Record<string, unknown>, spec: Record<string, unknown>, specPath: Path): PostgresTarget[] {
  const out: PostgresTarget[] = [];
  const kinds = volumeKinds(obj, spec);
  const meta = isRecord(obj.metadata) ? obj.metadata : {};
  const objName = `${asString(obj.kind) ?? ''}/${asString(meta.name) ?? '?'}`;
  const init = Array.isArray(spec.initContainers) ? spec.initContainers : [];
  const initHint = /pgautoupgrade|postgres-upgrade|pg_upgrade|pg_dumpall|pg_restore/.exec(JSON.stringify(init));

  // Native sidecars (initContainers with restartPolicy: Always) run for the pod's whole life, like containers.
  const containers = Array.isArray(spec.containers) ? spec.containers : [];
  const running: Array<[unknown, Path]> = [
    ...containers.map((c, i): [unknown, Path] => [c, [...specPath, 'containers', i]]),
    ...init.flatMap((c, i): Array<[unknown, Path]> => (isRecord(c) && c.restartPolicy === 'Always' ? [[c, [...specPath, 'initContainers', i]]] : [])),
  ];
  running.forEach(([c, cPath], i) => {
    if (!isRecord(c)) return;
    const imageRef = asString(c.image);
    const image = imageRef === null ? null : parseImage(imageRef);
    if (!image) return;

    let pgdata: string | null = null;
    let initdbArgs: string | null = null;
    let pgdataUnknown = Array.isArray(c.envFrom) && c.envFrom.length > 0;
    if (Array.isArray(c.env)) {
      for (const e of c.env) {
        if (!isRecord(e)) continue;
        const name = asString(e.name);
        const value = asString(e.value);
        if (name === 'PGDATA') {
          if (value === null) pgdataUnknown = true;
          else pgdata = value;
        }
        if (name === 'POSTGRES_INITDB_ARGS') initdbArgs = value;
      }
    }
    const mounts: Mount[] = [];
    if (Array.isArray(c.volumeMounts)) {
      c.volumeMounts.forEach((m, j) => {
        if (!isRecord(m)) return;
        const target = asString(m.mountPath);
        const vol = asString(m.name);
        if (!target) return;
        const k = (vol ? kinds.get(vol) : undefined) ?? { kind: 'other' as const, source: null };
        mounts.push({ target, kind: k.kind, source: k.source ?? vol, persistent: k.kind === 'pvc' || k.kind === 'host-path', line: y.lineOf([...cPath, 'volumeMounts', j]) });
      });
    }
    out.push({
      file,
      kind: 'kubernetes',
      name: `${objName}/${asString(c.name) ?? String(i)}`,
      image,
      line: y.lineOf([...cPath, 'image']),
      pgdata,
      pgdataUnknown,
      initdbArgs,
      mounts,
      ephemeral: false,
      upgradeStep: initHint ? `initContainer (${initHint[0]})` : null,
      previousMajor: null,
    });
  });
  return out;
}

/** Postgres containers in plain Kubernetes manifests (one or more YAML documents, or a List). */
export function kubernetesTargets(file: string, text: string): PostgresTarget[] {
  const out: PostgresTarget[] = [];
  for (const y of parseYaml(text)) {
    if (!isRecord(y.value)) continue;
    const items: Array<[Record<string, unknown>, Path]> =
      asString(y.value.kind) === 'List' && Array.isArray(y.value.items)
        ? y.value.items.flatMap((it, i): Array<[Record<string, unknown>, Path]> => (isRecord(it) ? [[it, ['items', i]]] : []))
        : [[y.value, []]];
    for (const [obj, prefix] of items) {
      const ps = podSpec(obj);
      if (ps) out.push(...containerTargets(file, y, obj, ps.spec, [...prefix, ...ps.path]));
    }
  }
  return out;
}

/** True when a YAML text looks like a Kubernetes manifest. */
export function looksLikeKubernetes(text: string): boolean {
  return /^\s*apiVersion:/m.test(text) && /^\s*kind:/m.test(text);
}
