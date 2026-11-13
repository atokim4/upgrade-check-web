export type Severity = "error" | "warning" | "note";

export type CheckerId =
  | "supabase-cli-v3"
  | "node26"
  | "preflight"
  | "prisma"
  | "llm"
  | "gemini-25"
  | "google-cse"
  | "deno"
  | "pg18"
  | "n8n"
  | "eslint10";

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  message: string;
  file: string;
  line: number;
  snippet?: string;
  why: string;
  fix: string;
  /** The changelog, guide or docs section the rule is based on. */
  sourceUrl: string;
  /** A unified diff of this finding's own fix, when the checker can rewrite it safely. */
  diff?: string;
  /** Found by a text pattern standing in for the CLI's syntax-tree check: worth a look, not proof. */
  approx?: boolean;
}

export interface CheckerReport {
  id: CheckerId;
  name: string;
  /** What the checker is about, one line. */
  about: string;
  /** Version of the CLI the rules come from; undefined for rules that live only in this page. */
  version?: string;
  /** The CLI's repository, or the official page for rules that live only in this page. */
  repoUrl: string;
  /** The command that runs the CLI on a local checkout, if there is a CLI. */
  cli?: { command: string; label: string };
  rulesChecked: number;
  findings: Finding[];
  /** Every safe fix of this checker as one patch (`git apply`), or undefined when there is none. */
  patch?: string;
  /** Things the reader should know about this run (checks switched off, partial reads). */
  notes: string[];
}

/** One line of a text file that is code, not a comment, with its 1-based line number. */
export interface CodeLine {
  line: number;
  text: string;
}
