import type { Finding as PgFinding, PostgresTarget, SourceKind } from "../engines/pg18/model.ts";
import { evaluate } from "../engines/pg18/rules.ts";
import { actionsTargets } from "../engines/pg18/sources/actions.ts";
import { composeTargets } from "../engines/pg18/sources/compose.ts";
import { dockerfileTargets } from "../engines/pg18/sources/dockerfile.ts";
import { helmTargets } from "../engines/pg18/sources/helm.ts";
import { kubernetesTargets, looksLikeKubernetes } from "../engines/pg18/sources/kubernetes.ts";
import type { Snapshot } from "../engines/pg18/sources/util.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding, Severity } from "../lib/types.ts";

const DOCKER_PR = "https://github.com/docker-library/postgres/pull/1259";
const PG_UPGRADE = "https://www.postgresql.org/docs/18/pgupgrade.html";
const RELEASE_18 = "https://www.postgresql.org/docs/18/release-18.html";
const VERSIONING = "https://www.postgresql.org/support/versioning/";

/** Final community release of each major (postgresql.org/support/versioning, read 2026-11-13). */
export const FINAL_RELEASE: Readonly<Record<number, string>> = {
  12: "2024-11-21",
  13: "2025-11-13",
  14: "2026-11-12",
  15: "2027-11-11",
};

interface Rule {
  title: string;
  why: string;
  source: string;
}

export const RULES: Record<string, Rule> = {
  "data-mount": {
    title: "Volume at /var/lib/postgresql/data on a Postgres 18+ image",
    why: "From 18 the official image keeps data in /var/lib/postgresql/<major>/docker. A mount at the old path makes the entrypoint exit before initdb on a first start.",
    source: DOCKER_PR,
  },
  "pgdata-not-persisted": {
    title: "PGDATA outside every persistent mount",
    why: "The data lands in the image's anonymous volume and is lost when the container is recreated.",
    source: DOCKER_PR,
  },
  "floating-tag": {
    title: "Floating Postgres tag on a volume that holds data",
    why: "`latest` and other floating tags have pointed at 18 since September 2025, and 18 cannot open data written by 17 or older.",
    source: PG_UPGRADE,
  },
  "eol-major": {
    title: "Postgres major past its final release",
    why: "The PostgreSQL project stops fixing bugs and security issues in a major after its final release.",
    source: VERSIONING,
  },
  "major-bump": {
    title: "Major version bump on an existing volume",
    why: "A new major cannot open data files written by an older one.",
    source: PG_UPGRADE,
  },
  checksums: {
    title: "Data checksums on by default in 18",
    why: "pg_upgrade stops when the old cluster has checksums off and the new one has them on.",
    source: RELEASE_18,
  },
  "skipped-image": {
    title: "Postgres image with its own data layout",
    why: "These rules are about the official image's layout.",
    source: DOCKER_PR,
  },
};

/** These compare the file with its previous version, which a single snapshot of the repo doesn't have. */
const NEEDS_BASE = new Set(["major-bump", "checksums"]);

const SEVERITY: Record<PgFinding["severity"], Severity> = { error: "error", warning: "warning", info: "note" };

function classify(path: string, text: string): SourceKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/.test(name)) return "compose";
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return "github-actions";
  if (name === "dockerfile" || name.endsWith(".dockerfile") || /^dockerfile[.-]/.test(name) || name === "containerfile") return "dockerfile";
  if (/^values([.-][\w.-]+)?\.ya?ml$/.test(name)) return "helm-values";
  if (/\.ya?ml$/.test(name) && looksLikeKubernetes(text)) return "kubernetes";
  return null;
}

function targetsFor(kind: SourceKind, file: string, text: string, snap: Snapshot): PostgresTarget[] {
  switch (kind) {
    case "compose":
      return composeTargets(file, text, snap);
    case "github-actions":
      return actionsTargets(file, text);
    case "dockerfile":
      return dockerfileTargets(file, text);
    case "helm-values":
      return helmTargets(file, text);
    case "kubernetes":
      return kubernetesTargets(file, text);
  }
}

function eolFinding(t: PostgresTarget, today: string): PgFinding | undefined {
  const major = t.image.major;
  if (t.image.layout === "other" || major === null) return undefined;
  const final = major < 12 ? "before 2024" : FINAL_RELEASE[major];
  if (!final || (/^\d/.test(final) && final > today)) return undefined;
  return {
    rule: "eol-major" as PgFinding["rule"],
    severity: "warning",
    file: t.file,
    line: t.line,
    target: t.name,
    image: t.image.raw,
    message: `${t.image.raw} runs Postgres ${major}, whose final community release was ${final}. No more bug or security fixes.`,
    fix: ["plan the upgrade to 17 or 18 (pg_upgrade, or dump and restore into a new volume); 18 also moves the data directory, see the other checks"],
  };
}

export function check(repo: LoadedRepo, today: string): CheckerReport {
  const snap: Snapshot = { read: (p) => repo.texts.get(p) ?? null };
  const targets: PostgresTarget[] = [];
  for (const [path, text] of [...repo.texts].sort(([a], [b]) => a.localeCompare(b))) {
    const kind = classify(path, text);
    if (kind && text) targets.push(...targetsFor(kind, path, text, snap));
  }
  const raw = targets.flatMap((t) => [...evaluate(t), ...[eolFinding(t, today)].filter((f): f is PgFinding => f !== undefined)]);

  const findings: Finding[] = raw.map((f) => {
    const rule = RULES[f.rule]!;
    const fix = f.fix.length ? f.fix.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(". ") + "." : "Nothing to change.";
    return { rule: f.rule, severity: SEVERITY[f.severity], title: rule.title, message: `${f.target}: ${f.message}`, file: f.file, line: f.line, why: rule.why, fix, sourceUrl: rule.source };
  });
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const notes = targets.length
    ? [`Found ${targets.length} Postgres container${targets.length === 1 ? "" : "s"}. A major bump on an existing volume shows up only against the old version of the file: run the CLI with --base origin/main on the PR.`]
    : [];
  return {
    id: "pg18",
    name: "Postgres 18 in Docker",
    about: "The official postgres:18 image moved its data directory, so an old-style volume mount stops the container on first start. Also: floating tags and majors past their final release (14: 2026-11-12).",
    version: versions.pg18.version,
    repoUrl: `https://github.com/${versions.pg18.repo}`,
    cli: {
      label: "Full check on a local checkout",
      command: `git clone https://github.com/${versions.pg18.repo} /tmp/pg18 && (cd /tmp/pg18 && npm ci && npm run build) && node /tmp/pg18/dist/src/cli.js . --base origin/main`,
    },
    rulesChecked: Object.keys(RULES).filter((r) => !NEEDS_BASE.has(r)).length,
    findings,
    notes,
  };
}
