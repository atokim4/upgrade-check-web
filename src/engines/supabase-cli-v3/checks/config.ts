import { ruleMeta } from "../rules.ts";
import { lineOf } from "../sources.ts";
import { parseToml, unquote, type TomlDoc } from "../toml.ts";
import type { Edit, Finding, Severity, SourceFile } from "../types.ts";

export interface ConfigFacts {
  /** The repo runs `supabase config push` somewhere. */
  runsConfigPush: boolean;
  /** SUPABASE_* names that CI or an env file sets (config overrides, not credentials). */
  envOverrides: Map<string, string>;
}

const finding = (rule: string, file: SourceFile, line: number, message: string, edits?: Edit[], severity?: Severity): Finding => ({
  rule,
  severity: severity ?? ruleMeta(rule).severity,
  message,
  file: file.path,
  line,
  snippet: file.text.split("\n")[line - 1]?.trim(),
  ...(edits && edits.length ? { edits } : {}),
});

const REMOTE = /^remotes\.([^.]+)\.(.+)$/;
/** `remotes.prod.auth.sms` → `auth.sms`, so rules can match the base table and any [remotes.<name>] copy of it. */
const base = (table: string) => REMOTE.exec(table)?.[2] ?? table;

export function checkConfigToml(file: SourceFile, facts: ConfigFacts): Finding[] {
  const doc = parseToml(file.text);
  const out: Finding[] = [];
  inbucket(file, doc, out);
  removedKeys(file, doc, out);
  enableSignup(file, doc, out);
  smsConfirmations(file, doc, facts, out);
  remotesPrecedence(file, doc, facts, out);
  if (!doc.keys.some((k) => k.table === "" && k.key === "project_id" && unquote(k.value) !== "")) {
    out.push(finding("project-id-missing", file, 1, "no project_id: v3 names local containers and volumes after the folder, so run `supabase stop` before upgrading or set project_id"));
  }
  return out;
}

function inbucket(file: SourceFile, doc: TomlDoc, out: Finding[]): void {
  for (const h of doc.headers) {
    const parts = h.name.split(".");
    const at = parts[0] === "inbucket" ? 0 : parts[0] === "remotes" && parts[2] === "inbucket" ? 2 : -1;
    if (at === -1) continue;
    const renamed = [...parts.slice(0, at), "local_smtp", ...parts.slice(at + 1)].join(".");
    const header = `[${h.name}]`;
    out.push(finding("inbucket-section", file, h.line, `${header} makes every v3 command that loads the config fail ("[inbucket] in supabase/config.toml is no longer supported. Use [local_smtp] instead."); rename it to [${renamed}]`, [
      { start: h.nameStart, end: h.nameEnd, text: renamed },
    ]));
  }
}

function removedKeys(file: SourceFile, doc: TomlDoc, out: Finding[]): void {
  for (const k of doc.keys) {
    if (base(k.table) === "experimental" && k.key === "orioledb_version" && unquote(k.value) !== "") {
      out.push(finding("removed-config-key", file, k.line, "[experimental] orioledb_version fails in v3; move it to [db] orioledb_version"));
    }
    if (/port$/.test(k.key) && /^0\d+$/.test(k.value)) {
      out.push(finding("removed-config-key", file, k.line, `${k.key} = ${k.value}: v3 rejects ports with a leading zero`));
    }
  }
  for (const h of doc.headers) {
    const b = base(h.name);
    const provider = /^auth\.external\.(linkedin|slack)$/.exec(b);
    if (provider) {
      out.push(finding("removed-config-key", file, h.line, `[${h.name}] fails in v3, even when disabled; use [${h.name}_oidc] (the OIDC provider needs its own app settings, so this is not a rename)`));
    }
    if (b === "experimental.inspect.rules" && !h.array) {
      out.push(finding("removed-config-key", file, h.line, "inspect report needs [[experimental.inspect.rules]] (an array of tables); a single [experimental.inspect.rules] table fails"));
    }
  }
}

function enableSignup(file: SourceFile, doc: TomlDoc, out: Finding[]): void {
  for (const k of doc.keys) {
    const b = base(k.table);
    if (k.key !== "enable_signup" || (b !== "auth.email" && b !== "auth.sms")) continue;
    const hasEnabled = doc.keys.some((o) => o.table === k.table && o.key === "enabled");
    const edits = hasEnabled ? undefined : [{ start: k.keyStart, end: k.keyEnd, text: "enabled" }];
    out.push(finding("enable-signup-deprecated", file, k.line, `enable_signup in [${k.table}] is deprecated (removed in v4); rename it to enabled. false also stops existing users signing in that way; to block only new sign-ups set enable_signup = false under [auth]`, edits));
  }
}

function smsConfirmations(file: SourceFile, doc: TomlDoc, facts: ConfigFacts, out: Finding[]): void {
  for (const k of doc.keys) {
    if (k.key !== "enable_confirmations" || base(k.table) !== "auth.sms") continue;
    const now = k.value === "true" ? "turns phone confirmation on (sign-ups need a working SMS provider)" : "turns phone confirmation off";
    const severity: Severity = facts.runsConfigPush ? "warning" : "note";
    out.push(finding("sms-confirmations-flip", file, k.line, `[${k.table}] enable_confirmations = ${k.value}: v3 config push applies it as written and ${now}; v2 applied it inverted. Run supabase config diff before the first v3 push`, undefined, severity));
  }
}

function remotesPrecedence(file: SourceFile, doc: TomlDoc, facts: ConfigFacts, out: Finding[]): void {
  const first = doc.headers.find((h) => REMOTE.test(h.name) || /^remotes\.[^.]+$/.test(h.name));
  if (!first) return;
  const names = [...facts.envOverrides.keys()];
  if (names.length) {
    const list = names.slice(0, 6).map((n) => `${n} (${facts.envOverrides.get(n)})`).join(", ");
    out.push(finding("env-overrides-remotes", file, first.line, `[remotes.*] blocks no longer beat SUPABASE_* variables in v3, and these are set: ${list}${names.length > 6 ? ", …" : ""}. They now win and config push pushes them`));
  } else {
    out.push(finding("env-overrides-remotes", file, first.line, "[remotes.*] blocks no longer beat SUPABASE_* variables in v3; check `env | grep ^SUPABASE_` in CI, set SUPABASE_ENV there, and run supabase config diff before the first v3 config push", undefined, "note"));
  }
}

export function checkConfigJson(file: SourceFile): Finding[] {
  const out: Finding[] = [];
  for (const m of file.text.matchAll(/"inbucket"(\s*:)/g)) {
    const at = m.index!;
    out.push(finding("inbucket-section", file, lineOf(file.text, at), 'the "inbucket" key fails in v3; rename it to "local_smtp" (the keys inside stay the same)', [
      { start: at, end: at + '"inbucket"'.length, text: '"local_smtp"' },
    ]));
  }
  return out;
}

/** Facts about the repo's config files that command rules need. */
export function configFacts(files: SourceFile[], paths: string[]): { declarativeSchemas: boolean; migraPinned: boolean } {
  let declarativeSchemas = paths.some((p) => /(^|\/)supabase\/schemas\/.+\.sql$/.test(p));
  let migraPinned = false;
  for (const f of files.filter((x) => x.kind === "config-toml")) {
    const doc = parseToml(f.text);
    if (doc.keys.some((k) => k.table === "db.migrations" && k.key === "schema_paths" && k.value !== "[]")) declarativeSchemas = true;
    if (doc.keys.some((k) => k.table === "experimental.pgdelta" && k.key === "enabled" && k.value === "false")) migraPinned = true;
  }
  return { declarativeSchemas, migraPinned };
}
