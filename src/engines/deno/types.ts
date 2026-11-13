export type Target = "node" | "bun" | "workers";

/**
 * - auto: `--fix` rewrites it
 * - manual: needs a code change a person has to make (no safe 1:1 rewrite)
 * - decision: needs a choice (storage, scheduler, framework) before any code moves; never rewritten
 * - info: worth knowing, nothing to change
 */
export type FixKind = "auto" | "manual" | "decision" | "info";

export type Category = "config" | "specifier" | "api" | "decision" | "deploy" | "typescript";

export interface Finding {
  rule: string;
  category: Category;
  fix: FixKind;
  file: string;
  line: number;
  message: string;
  /** What to use instead, when there is a known replacement. */
  replacement?: string;
  /** Short excerpt of the matched code. */
  snippet?: string;
}

export interface ScanOptions {
  target: Target;
  fix: boolean;
}

export interface FileChange {
  file: string;
  /** null when the file is new. */
  before: string | null;
  after: string;
}

/** package.json entries the fix wants to add. Value is the dependency spec (range or `npm:` alias). */
export interface DependencyPlan {
  dependencies: Map<string, string>;
  devDependencies: Map<string, string>;
  /** Where each dependency came from, for the report. */
  origin: Map<string, string>;
  needsJsrRegistry: boolean;
}

export interface ScanResult {
  root: string;
  target: Target;
  /** Relative paths of deno.json / deno.jsonc files found. */
  denoConfigs: string[];
  findings: Finding[];
  changes: FileChange[];
  /** Findings `--fix` resolved (only filled when fixing). */
  fixed: Finding[];
  /** How TypeScript is run after the move: Node type stripping or tsx, and why. */
  runner: { tool: "node" | "tsx" | "bun" | "wrangler"; reasons: string[] };
}
