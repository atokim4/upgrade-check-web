import type { ImageInfo } from './image.js';

export type SourceKind = 'compose' | 'kubernetes' | 'github-actions' | 'dockerfile' | 'helm-values';

export type MountKind = 'named-volume' | 'bind' | 'anonymous' | 'tmpfs' | 'pvc' | 'host-path' | 'empty-dir' | 'other';

export interface Mount {
  target: string;
  kind: MountKind;
  /** Volume name, host path or claim name when there is one. */
  source: string | null;
  /** Data survives a container being recreated (named volume, bind mount, PVC, host path). */
  persistent: boolean;
  line: number;
  /** Set when the mount is declared in another file than the target (a Helm chart template). */
  file?: string;
}

/** One Postgres container definition found in a file. */
export interface PostgresTarget {
  file: string;
  kind: SourceKind;
  /** Compose service, workflow `job/service`, `Kind/name/container`, Dockerfile stage. */
  name: string;
  image: ImageInfo;
  line: number;
  /** PGDATA set on the container, null when not set. */
  pgdata: string | null;
  /** PGDATA may come from somewhere we cannot read (missing env_file, envFrom, chart templates). */
  pgdataUnknown: boolean;
  /** env_file entries that are not in the repo (usually a gitignored `.env`). */
  missingEnvFiles?: string[];
  /** Committed templates (`.env.example`...) read in place of a missing env_file. */
  envTemplates?: string[];
  initdbArgs: string | null;
  mounts: Mount[];
  /** CI service containers start from scratch every run. */
  ephemeral: boolean;
  /** An upgrade step that sits next to this container (pgautoupgrade, pg_upgrade, pg_dump/restore). */
  upgradeStep: string | null;
  /** Major the same container ran before (from --base or --from). */
  previousMajor: number | null;
}

export type Severity = 'error' | 'warning' | 'info';

export type RuleId = 'data-mount' | 'major-bump' | 'checksums' | 'floating-tag' | 'pgdata-not-persisted' | 'skipped-image';

export interface Finding {
  rule: RuleId;
  severity: Severity;
  file: string;
  line: number;
  target: string;
  image: string;
  message: string;
  fix: string[];
}

/** A file that looked relevant but could not be read in full. */
export interface FileProblem {
  file: string;
  line: number;
  message: string;
}

export interface ScanResult {
  root: string;
  filesScanned: number;
  /** Files (or YAML documents in them) skipped because they did not parse. */
  unreadable: FileProblem[];
  /** Helm chart templates (Go-template YAML): read as text for mounts and PGDATA, not parsed. */
  helmTemplates: number;
  targets: PostgresTarget[];
  findings: Finding[];
}
