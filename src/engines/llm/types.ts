export type Severity = "error" | "warn";
export type Provider = "openai" | "anthropic" | "perspective";

export interface Finding {
  file: string;
  line: number;
  provider: Provider;
  rule: string;
  severity: Severity;
  message: string;
  /** True when `--fix` rewrites this spot. */
  fixable?: boolean;
  /** The model behind this finding shuts down within 30 days, or already has. */
  urgent?: boolean;
}

/** A text replacement in one file: characters [start, end) become `text`. */
export interface Edit {
  start: number;
  end: number;
  text: string;
}
