export type Severity = "error" | "warning" | "note";

export const SEVERITY_ORDER: Record<Severity, number> = { error: 3, warning: 2, note: 1 };

/** A text replacement in one file, by character offsets into the original text. */
export interface Edit {
  start: number;
  end: number;
  text: string;
  /** Inserts at the same offset are applied in ascending order. */
  order?: number;
}

export interface Finding {
  rule: string;
  severity: Severity;
  /** One line: what is wrong and what to write instead. */
  message: string;
  /** Path relative to the scanned root, forward slashes. */
  file: string;
  line: number;
  /** The line as written, for the report. */
  snippet?: string;
  /** Present when --fix can rewrite it safely. */
  edits?: Edit[];
}

export type FileKind =
  | "dockerfile"
  | "workflow"
  | "gitlab"
  | "jenkinsfile"
  | "netlify"
  | "vercel"
  | "package"
  | "node-version"
  | "shell"
  | "makefile"
  | "agent-doc"
  | "lockfile"
  | "source";

export interface SourceFile {
  /** Relative path, forward slashes. */
  path: string;
  text: string;
  kind: FileKind;
}

export interface RuleMeta {
  id: string;
  severity: Severity;
  title: string;
  /** Why it breaks, 1-2 sentences, from the source. */
  why: string;
  /** What to write instead. */
  fix: string;
  /** The official page or commit the rule is based on. */
  source: string;
  /** Deprecation code, for API rules. */
  dep?: string;
  /** --fix can rewrite at least some of its findings. */
  fixable: boolean;
}
