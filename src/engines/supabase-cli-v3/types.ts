export type Severity = "error" | "warning" | "note";

export const SEVERITY_ORDER: Record<Severity, number> = { error: 3, warning: 2, note: 1 };

/** Where a command runs decides whether it can prompt: CI never can, agents never get a prompt, scripts may. */
export type Context = "ci" | "agent" | "script";

/** A text replacement in one file, by character offsets into the original text. */
export interface Edit {
  start: number;
  end: number;
  text: string;
  /** Inserts at the same offset are applied in ascending order (so `--yes` lands before `--remote`). */
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
  /** The command or config line as written, for the report. */
  snippet?: string;
  /** Present when --fix can rewrite it safely. */
  edits?: Edit[];
}

export interface SourceFile {
  /** Relative path, forward slashes. */
  path: string;
  text: string;
  kind: "workflow" | "gitlab" | "ci-other" | "package" | "shell" | "makefile" | "dockerfile" | "config-toml" | "config-json" | "env" | "agent-doc";
}

export interface RuleMeta {
  id: string;
  severity: Severity;
  title: string;
  /** Why it breaks, 1-2 sentences, from the guide. */
  why: string;
  /** What to write instead. */
  fix: string;
  /** Anchor of the migration guide section the rule is based on. */
  section: string;
  /** --fix can rewrite at least some of its findings. */
  fixable: boolean;
}
