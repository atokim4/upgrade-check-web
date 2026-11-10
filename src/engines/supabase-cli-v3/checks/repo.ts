import { ruleMeta } from "../rules.ts";
import type { ParsedCommand } from "../shell.ts";
import { isCi, lineOf } from "../sources.ts";
import { unquote } from "../toml.ts";
import type { Edit, Finding, Severity, SourceFile } from "../types.ts";

const finding = (rule: string, file: string, line: number, message: string, opts: { edits?: Edit[]; severity?: Severity; snippet?: string } = {}): Finding => ({
  rule,
  severity: opts.severity ?? ruleMeta(rule).severity,
  message,
  file,
  line,
  ...(opts.snippet ? { snippet: opts.snippet } : {}),
  ...(opts.edits && opts.edits.length ? { edits: opts.edits } : {}),
});

const TEXT_KINDS = new Set<SourceFile["kind"]>(["workflow", "gitlab", "ci-other", "shell", "makefile", "dockerfile", "env", "package"]);
const TRUTHY = `["']?(?:1|t|T|true|True|TRUE)["']?`;

const lineAt = (text: string, offset: number) => {
  const line = lineOf(text, offset);
  return { line, snippet: text.split("\n")[line - 1]?.trim() };
};

interface Rename {
  name: string;
  rule: string;
  severity?: Severity;
  to?: string;
  message: string;
  /** Only rewrite when this also holds for the file. */
  fixIf?: (f: SourceFile) => boolean;
}

const RENAMES: Rename[] = [
  { name: "SUPABASE_EXPERIMENTAL_PG_DELTA", rule: "removed-env-var", to: "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED", message: "SUPABASE_EXPERIMENTAL_PG_DELTA is ignored by v3; use SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED" },
  { name: "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION", rule: "removed-env-var", severity: "error", to: "SUPABASE_DB_ORIOLEDB_VERSION", message: "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION fails in v3 when non-empty; use SUPABASE_DB_ORIOLEDB_VERSION" },
  { name: "COBRA_COMPLETION_DESCRIPTIONS", rule: "removed-env-var", severity: "note", to: "SUPABASE_COMPLETION_DESCRIPTIONS", message: "COBRA_COMPLETION_DESCRIPTIONS is ignored by v3; use SUPABASE_COMPLETION_DESCRIPTIONS" },
  { name: "SUPABASE_GO_BINARY", rule: "supabase-go-binary", severity: "warning", message: "SUPABASE_GO_BINARY is ignored by v3, which ships a single supabase executable" },
  {
    name: "INBUCKET_URL",
    rule: "inbucket-url",
    to: "MAILPIT_URL",
    message: "supabase status no longer prints INBUCKET_URL, so this reads an empty value in v3; use MAILPIT_URL",
    fixIf: (f) => /\bsupabase\s+status\b/.test(f.text),
  },
  { name: "MigrationPasswordFlagsError", rule: "error-name-renamed", to: "DbPasswordFlagsError", message: "v3 renamed MigrationPasswordFlagsError to DbPasswordFlagsError" },
];

/** Removed or renamed environment variables and error names, wherever scripts, CI or env files mention them. */
export function checkRenames(files: SourceFile[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!TEXT_KINDS.has(f.kind)) continue;
    for (const r of RENAMES) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${r.name}(?![A-Za-z0-9_])`, "g");
      for (const m of f.text.matchAll(re)) {
        const at = m.index!;
        const fix = r.to && (!r.fixIf || r.fixIf(f)) ? [{ start: at, end: at + r.name.length, text: r.to }] : undefined;
        out.push(finding(r.rule, f.path, lineOf(f.text, at), r.message, { edits: fix, severity: r.severity, snippet: lineAt(f.text, at).snippet }));
      }
    }
  }
  return out;
}

export function checkEnvFiles(files: SourceFile[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files.filter((x) => x.kind === "env")) {
    for (const m of f.text.matchAll(/^[ \t]*(?:export[ \t]+)?SUPABASE_YES[ \t]*=/gm)) {
      const { line, snippet } = lineAt(f.text, m.index!);
      out.push(finding("supabase-yes-in-env-file", f.path, line, "SUPABASE_YES in an env file doesn't confirm hosted changes, and while it is defined here a shell-exported SUPABASE_YES doesn't count either; remove it and pass --yes", { snippet }));
    }
  }
  return out;
}

export function checkFunctionImportMaps(paths: string[]): Finding[] {
  return paths
    .filter((p) => /(^|\/)supabase\/functions\/[^/]+\/import_map\.json$/.test(p))
    .map((p) => finding("function-import-map", p, 1, "a function's own import_map.json fails in v3; rename it to deno.json or set [functions.<name>] import_map in config.toml (the shared supabase/functions/import_map.json still works)"));
}

/** The CLI version a lockfile at the repo root pins, which setup-cli installs instead of `latest`. */
export function lockfilePin(paths: string[], read: (p: string) => string | undefined): string | undefined {
  if (paths.includes("package-lock.json")) {
    const m = /"node_modules\/supabase":\s*\{[^}]*?"version":\s*"([^"]+)"/.exec(read("package-lock.json") ?? "");
    if (m) return `package-lock.json pins supabase ${m[1]}`;
  }
  if (paths.includes("pnpm-lock.yaml") && /\n\s+supabase@?['"]?\d|\/supabase@\d|\n\s+supabase:\n/.test(read("pnpm-lock.yaml") ?? "")) return "pnpm-lock.yaml pins supabase";
  if (paths.includes("bun.lock") && /"supabase":\s*\["supabase@/.test(read("bun.lock") ?? "")) return "bun.lock pins supabase";
  return undefined;
}

/** `uses: supabase/setup-cli@…` steps and their `version` input. */
export function checkSetupCli(files: SourceFile[], pin: string | undefined): Finding[] {
  const out: Finding[] = [];
  for (const f of files.filter((x) => x.kind === "workflow")) {
    const lines = f.text.split("\n");
    lines.forEach((l, i) => {
      const m = /^(\s*)(-\s+)?uses:\s*["']?supabase\/setup-cli@([\w.-]+)/.exec(l);
      if (!m) return;
      const stepIndent = m[2] ? m[1]!.length : m[1]!.length - 2;
      let version: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const n = lines[j]!;
        if (n.trim() === "") continue;
        if (n.length - n.trimStart().length <= stepIndent) break;
        const v = /^\s*version:\s*(.+?)\s*(#.*)?$/.exec(n);
        if (v) version = unquote(v[1]!);
      }
      const ref = m[3]!;
      const major = Number(/^v?(\d+)/.exec(ref)?.[1] ?? "0");
      const snippet = l.trim();
      const v2Pin = version !== undefined && (/^v?2(\.|$)/.test(version) || /^[\^~]2/.test(version) || version === "v2.stable");
      const needsV3Action = version !== undefined && (version === "v2.stable" || /^[\^~<>=*]/.test(version) || /x/i.test(version));
      if (needsV3Action && major < 3) {
        out.push(finding("cli-version", f.path, i + 1, `version: ${version} needs supabase/setup-cli@v3; @${ref} can't resolve it`, { severity: "error", snippet }));
      } else if (version === undefined || version === "latest") {
        const how = version === undefined ? "no version set" : "version: latest";
        const extra = pin ? ` (${pin}, and setup-cli uses that instead)` : "";
        out.push(finding("cli-version", f.path, i + 1, `${how}: this job installs CLI v3 since 2026-11-02${extra}. Pin version: v2.stable on supabase/setup-cli@v3 to upgrade later, or fix the other findings`, { snippet }));
      } else if (v2Pin) {
        out.push(finding("cli-version", f.path, i + 1, `pinned to CLI v2 (${version}); the other findings are what breaks when you move this job to v3`, { snippet }));
      }
    });
  }
  return out;
}

/** CI files that set SUPABASE_PROJECT_ID but never link, while some command has no explicit target. */
export function checkProjectIdTarget(files: SourceFile[], commands: Map<string, ParsedCommand[]>): Finding[] {
  const out: Finding[] = [];
  for (const f of files.filter(isCi)) {
    const cmds = commands.get(f.path) ?? [];
    if (cmds.length === 0 || cmds.some((c) => c.path[0] === "link")) continue;
    // A command that names the variable itself (`--remote="$SUPABASE_PROJECT_ID"`, even without the =) is explicit.
    const explicit = (c: ParsedCommand) =>
      c.flags.some((x) => (x.name === "--remote" && x.value) || x.name === "--project-ref" || x.name === "--db-url" || x.name === "--project-id") ||
      c.positionals.some((p) => p.value.includes("SUPABASE_PROJECT_ID"));
    const untargeted = cmds.some((c) => !explicit(c));
    if (!untargeted) continue;
    const m = /^[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?SUPABASE_PROJECT_ID[ \t]*[:=]/m.exec(f.text);
    if (!m) continue;
    const { line, snippet } = lineAt(f.text, m.index);
    out.push(finding("project-id-env-target", f.path, line, "SUPABASE_PROJECT_ID no longer selects the hosted project in v3 and this file never runs supabase link; it only says which project a bare --remote means, so add --remote to the commands that should use it", { snippet }));
  }
  return out;
}

/** Config sections a SUPABASE_<SECTION>_<KEY> variable can override. */
const CONFIG_SECTIONS = /^SUPABASE_(AUTH|API|DB|STUDIO|STORAGE|REALTIME|LOCAL_SMTP|INBUCKET|EDGE_RUNTIME|ANALYTICS|EXPERIMENTAL|FUNCTIONS)_[A-Z0-9_]+$/;
const NOT_OVERRIDES = new Set(["SUPABASE_DB_PASSWORD"]);

/** SUPABASE_* config overrides that CI files and env files set, with where. */
export function envOverrides(files: SourceFile[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of files) {
    if (!isCi(f) && f.kind !== "env") continue;
    for (const m of f.text.matchAll(/^[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?(SUPABASE_[A-Z0-9_]+)[ \t]*[:=]/gm)) {
      const name = m[1]!;
      if (CONFIG_SECTIONS.test(name) && !NOT_OVERRIDES.has(name) && !found.has(name)) found.set(name, f.path);
    }
  }
  return found;
}

export const exportsYes = (f: SourceFile) =>
  new RegExp(`(^[ \\t]*(?:-[ \\t]+)?SUPABASE_YES[ \\t]*:[ \\t]*${TRUTHY}[ \\t]*$)|(export[ \\t]+SUPABASE_YES=${TRUTHY})|(SUPABASE_YES=${TRUTHY}["']?[ \\t]*>>[ \\t]*["']?\\$GITHUB_ENV)`, "m").test(f.text);

export const setsExperimental = (f: SourceFile) =>
  new RegExp(`(^|[\\s"'])SUPABASE_EXPERIMENTAL[ \\t]*[:=][ \\t]*${TRUTHY}`, "m").test(f.text);
