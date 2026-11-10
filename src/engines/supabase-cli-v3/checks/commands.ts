import { ruleMeta } from "../rules.ts";
import { findInvocations, isKnownCommand, parseCommand, type Flag, type Invocation, type ParsedCommand, type Token } from "../shell.ts";
import { lineOf, type Region } from "../sources.ts";
import type { Edit, Finding, Severity } from "../types.ts";

/** Repo-wide facts some command rules depend on. */
export interface CommandFacts {
  /** Files that start a local stack (`supabase start`, `supabase db start`). */
  startsLocalStack: Set<string>;
  /** Files whose environment exports a truthy SUPABASE_YES (a CI `env:` key or `export SUPABASE_YES=1`). */
  exportsYes: Set<string>;
  /** Files that set SUPABASE_EXPERIMENTAL. */
  setsExperimental: Set<string>;
  /** supabase/schemas has SQL files, or config.toml sets [db.migrations] schema_paths. */
  declarativeSchemas: boolean;
  /** config.toml keeps migra with [experimental.pgdelta] enabled = false. */
  migraPinned: boolean;
}

/** Commands that ran against the linked project by default in v2 and against the local stack in v3. */
const LOCAL_BY_DEFAULT = ["db push", "db pull", "db dump", "migration fetch", "migration list", "migration repair", "inspect report", "storage ls", "storage cp", "storage mv", "storage rm"];
/** Hosted-only commands: they always change a hosted project (guide table "Commands that need --yes"). */
const ALWAYS_HOSTED = new Set([
  "functions deploy", "functions delete", "secrets set", "secrets unset", "config push",
  "projects create", "projects delete", "orgs create", "bootstrap", "backups restore",
  "branches create", "branches delete", "branches disable", "branches pause", "branches unpause", "branches update",
  "encryption update-root-key", "network-bans remove", "network-restrictions update", "ssl-enforcement update",
  "postgres-config update", "postgres-config delete", "sso add", "sso update", "sso remove",
  "vanity-subdomains activate", "vanity-subdomains delete", "domains create", "domains activate", "domains delete",
  "compute push", "compute delete", "notebooks push", "feedback delete",
]);
/** Commands that change the database or storage they target, so they ask when that target is hosted. */
const MUTATE_TARGET = new Set(["db push", "db pull", "pull", "migration up", "migration down", "migration squash", "migration repair", "db reset", "test db", "db query", "storage cp", "storage mv", "storage rm", "seed buckets"]);

const TRUTHY = /^(1|t|T|true|True|TRUE)$/;
const PROJECT_REF = /^[a-z]{20}$/;
const PG_URL = /^postgres(ql)?:\/\//;
const VARIABLE = /^\$/;

interface Ctx {
  region: Region;
  inv: Invocation;
  cmd: ParsedCommand;
  path: string;
  facts: CommandFacts;
  out: Finding[];
}

export function checkCommands(regions: Region[], facts: CommandFacts): Finding[] {
  const out: Finding[] = [];
  for (const region of regions) {
    for (const inv of findInvocations(region.lexText, region.start, region.end)) {
      const cmd = parseCommand(inv.args);
      if (cmd.flags.some((f) => f.name === "--help" || f.name === "-h") || cmd.path[0] === "help") continue;
      // `supabase-go` is reported whatever follows it; anything else must be a real CLI command.
      if (inv.binary === "supabase" && !isKnownCommand(cmd.path)) continue;
      const c: Ctx = { region, inv, cmd, path: cmd.path.join(" "), facts, out };
      if (inv.binary === "supabase-go") {
        add(c, "supabase-go-binary", undefined, "`supabase-go` is not installed by v3; call `supabase` (the commands that ran through supabase-go were removed)");
        continue;
      }
      removedCommand(c);
      removedFlags(c);
      const piped = pipedConfirmation(c);
      deprecatedTargets(c);
      remoteMissing(c);
      if (!piped) yesMissing(c);
      remoteWithoutEquals(c);
      smallerRules(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------- helpers

const flag = (c: Ctx, ...names: string[]) => c.cmd.flags.find((f) => names.includes(f.name));
const hasFlag = (c: Ctx, ...names: string[]) => flag(c, ...names) !== undefined;
const original = (c: Ctx, start: number, end: number) => c.region.file.text.slice(start, end);

/** The value of a flag as written in the file (quotes kept), for moving it into `--remote=…`. */
function rawValue(c: Ctx, f: Flag): string {
  const t = c.inv.args[f.index]!;
  if (f.attached) return original(c, t.start + t.raw.indexOf("=") + 1, t.end);
  const v = c.inv.args[f.valueIndex!]!;
  return original(c, v.start, v.end);
}

/** Deletes a flag and its value together with the blank before it. */
function removeFlag(c: Ctx, f: Flag): Edit {
  const prevEnd = f.index === 0 ? c.inv.binaryToken.end : c.inv.args[f.index - 1]!.end;
  const last = c.inv.args[f.valueIndex ?? f.index]!;
  return { start: prevEnd, end: last.end, text: "" };
}

function replaceFlag(c: Ctx, f: Flag, text: string): Edit {
  const first = c.inv.args[f.index]!;
  const last = c.inv.args[f.valueIndex ?? f.index]!;
  return { start: first.start, end: last.end, text };
}

/** Appends ` text` after the last argument (before any redirection), where the guide wants --remote. */
const append = (c: Ctx, text: string, order: number): Edit => ({ start: c.inv.argsEnd, end: c.inv.argsEnd, text: ` ${text}`, order });

const snippet = (c: Ctx) => original(c, c.inv.pipedFrom?.start ?? c.inv.binaryToken.start, c.inv.argsEnd).replace(/\s*\\\n\s*/g, " ").trim();

function add(c: Ctx, rule: string, edits: Edit[] | undefined, message: string, severity?: Severity): void {
  const file = c.region.file;
  c.out.push({
    rule,
    severity: severity ?? ruleMeta(rule).severity,
    message,
    file: file.path,
    line: lineOf(file.text, c.inv.binaryToken.start),
    snippet: snippet(c),
    ...(edits && edits.length ? { edits } : {}),
  });
}

const hasTarget = (c: Ctx) =>
  hasFlag(c, "--remote", "--linked", "--project-ref", "--db-url", "--local") || (c.path === "gen types" && hasFlag(c, "--project-id"));

/** v2 sent these to the linked project without a flag; adding --remote keeps that behaviour. */
const linkedByDefaultInV2 = (c: Ctx) => LOCAL_BY_DEFAULT.includes(c.path) || c.path.startsWith("inspect db ");

/** --fix appends --remote to this invocation (see remoteMissing). */
const willAddRemote = (c: Ctx) =>
  c.region.context === "ci" && linkedByDefaultInV2(c) && !hasTarget(c) && !c.facts.startsLocalStack.has(c.region.file.path);

const code = (s: string) => `\`${s}\``;

// ---------------------------------------------------------------- rules

const REMOVED_COMMANDS: Record<string, { use: string; replace?: string; remote?: boolean }> = {
  "db remote changes": { use: "supabase db diff --remote", replace: "db diff", remote: true },
  "db remote commit": { use: "supabase db pull --remote", replace: "db pull", remote: true },
  "gen keys": { use: "supabase projects api-keys --remote=<ref>" },
  "inspect db total-index-size": { use: "supabase inspect db index-stats", replace: "inspect db index-stats" },
  "inspect db total-table-sizes": { use: "supabase inspect db table-stats", replace: "inspect db table-stats" },
  "inspect db table-index-sizes": { use: "supabase inspect db table-stats", replace: "inspect db table-stats" },
};

function removedCommand(c: Ctx): void {
  if (c.path.startsWith("db branch ") || c.path === "db branch") {
    add(c, "removed-command", undefined, `${code(`supabase ${c.path}`)} was removed: local database branches are gone; manage hosted preview branches with ${code("supabase branches")}`);
    return;
  }
  const r = REMOVED_COMMANDS[c.path];
  if (!r) return;
  const edits: Edit[] = [];
  if (r.replace) {
    const first = c.inv.args[c.cmd.pathIndex[0]!]!;
    const last = c.inv.args[c.cmd.pathIndex[c.cmd.pathIndex.length - 1]!]!;
    edits.push({ start: first.start, end: last.end, text: r.replace });
    if (r.remote && !hasTarget(c)) edits.push(append(c, "--remote", 2));
  }
  add(c, "removed-command", edits, `${code(`supabase ${c.path}`)} was removed in v3 (exits 1); use ${code(r.use)}`);
}

function removedFlags(c: Ctx): void {
  const f = (name: string) => flag(c, name);
  const useSchema = c.path === "db diff" ? f("--use-pg-schema") : undefined;
  if (useSchema) add(c, "removed-flag", [removeFlag(c, useSchema)], `${code("db diff --use-pg-schema")} was removed; drop it to use the default engine (pg-delta), or pass ${code("--use-pg-delta")}`);

  if (c.path === "db pull") {
    const pgDelta = f("--use-pg-delta");
    if (pgDelta) {
      const edit = hasFlag(c, "--declarative") ? removeFlag(c, pgDelta) : replaceFlag(c, pgDelta, "--declarative");
      add(c, "removed-flag", [edit], `${code("db pull --use-pg-delta")} was removed; use ${code("db pull --declarative")}`);
    }
    const experimental = f("--experimental");
    const envExperimental = c.inv.envPrefix.has("SUPABASE_EXPERIMENTAL") || c.facts.setsExperimental.has(c.region.file.path);
    const expOn = experimental && (experimental.value === undefined || TRUTHY.test(experimental.value));
    if ((expOn || envExperimental) && !hasFlag(c, "--declarative")) {
      add(c, "removed-flag", undefined, `${code("db pull")} with ${expOn ? code("--experimental") : code("SUPABASE_EXPERIMENTAL")} and no ${code("--declarative")} now fails; pass ${code("--declarative")} for a declarative pull or ${code("--experimental=false")} for a migration pull`);
    }
  }

  const legacy = c.path === "functions download" ? f("--legacy-bundle") : undefined;
  if (legacy) add(c, "removed-flag", [replaceFlag(c, legacy, "--use-api")], `${code("functions download --legacy-bundle")} was removed; use ${code("--use-api")} (if that fails and the function was deployed with a CLI older than 1.120.0, redeploy it first)`);

  const raw = /^domains (create|get|reverify|activate|delete)$/.test(c.path) ? f("--include-raw-output") : undefined;
  if (raw) {
    const edit = hasFlag(c, "-o", "--output") ? removeFlag(c, raw) : replaceFlag(c, raw, "-o json");
    add(c, "removed-flag", [edit], `${code("--include-raw-output")} was removed; use ${code("-o json")}`);
  }

  const ticket = f("--create-ticket");
  if (ticket) add(c, "removed-flag", [removeFlag(c, ticket)], `the global ${code("--create-ticket")} flag was removed; report CLI problems with ${code("supabase issue bug")}`);
}

/** `echo y | supabase …` and friends. */
function isYesFeeder(words: string[]): boolean {
  const [cmd, ...rest] = words;
  const args = rest.filter((w) => !/^-[en]+$/.test(w));
  if (cmd === "yes") return args.length === 0 || (args.length === 1 && /^y(es)?$/i.test(args[0]!));
  if (cmd === "echo" || cmd === "printf") return args.length === 1 && /^y(es)?(\\n)?$/i.test(args[0]!);
  return false;
}

function pipedConfirmation(c: Ctx): boolean {
  const p = c.inv.pipedFrom;
  if (!p || !isYesFeeder(p.words)) return false;
  const edits: Edit[] = [{ start: p.start, end: p.end, text: "" }];
  if (!hasFlag(c, "--yes")) edits.push(append(c, "--yes", 1));
  add(c, "piped-confirmation", edits, `${code(`${p.words.join(" ")} |`)} no longer confirms anything in v3; pass ${code("--yes")} instead`);
  return true;
}

function deprecatedTargets(c: Ctx): void {
  if (c.cmd.path[0] === "link") return;
  const linked = flag(c, "--linked");
  const ref = flag(c, "--project-ref");
  const url = flag(c, "--db-url");
  const pid = c.path === "gen types" ? flag(c, "--project-id") : undefined;
  const local = flag(c, "--local");
  const diffLinked = c.path === "db diff" ? c.cmd.flags.filter((f) => (f.name === "--from" || f.name === "--to") && f.value === "linked") : [];
  const found = [linked, ref, url, pid, local].filter((f): f is Flag => f !== undefined);
  if (found.length === 0 && diffLinked.length === 0) return;

  const names = [...found.map((f) => f.name), ...diffLinked.map((f) => `${f.name} linked`)];
  const valued = [ref, url, pid].filter((f): f is Flag => f !== undefined && f.value !== undefined);
  const hasRemote = hasFlag(c, "--remote");
  const conflict = valued.length > 1 || (local !== undefined && (linked !== undefined || valued.length > 0)) || hasRemote;

  let wanted = "";
  if (valued.length === 1) wanted = `--remote=${rawValue(c, valued[0]!)}`;
  else if (linked || ref || url || pid) wanted = "--remote";

  const edits: Edit[] = [];
  if (!conflict) {
    for (const f of found) edits.push(removeFlag(c, f));
    for (const f of diffLinked) edits.push(replaceFlag(c, f, `${f.name}=remote`));
    if (wanted) edits.push(append(c, wanted, 2));
  }
  const advice = conflict
    ? hasRemote
      ? `${code("--remote")} can't be combined with ${names.map(code).join(", ")}; keep only ${code("--remote[=<value>]")}`
      : `conflicting target flags ${names.map(code).join(", ")}; pick one target and write it as ${code("--remote[=<value>]")}`
    : wanted
      ? `use ${code(wanted)} at the end of the command`
      : local
        ? `drop ${code("--local")}: local is the default in v3`
        : `use ${code("--from=remote")} / ${code("--to=remote")}`;
  add(c, "deprecated-target-flag", edits, `${names.map(code).join(", ")} ${names.length > 1 ? "are" : "is"} deprecated in v3 (removed in v4): ${advice}`);
}

function remoteMissing(c: Ctx): void {
  if (!linkedByDefaultInV2(c) || hasTarget(c)) return;
  const what = code(`supabase ${c.path}`);
  switch (c.region.context) {
    case "ci":
      if (c.facts.startsLocalStack.has(c.region.file.path)) {
        add(c, "remote-flag-missing", undefined, `${what} now runs against the local stack this job starts and never reaches the hosted project; add ${code("--remote")} if it should`, "warning");
      } else {
        add(c, "remote-flag-missing", [append(c, "--remote", 2)], `${what} targets the local stack in v3 (v2 used the linked project); add ${code("--remote")} at the end to keep deploying to the hosted project`);
      }
      return;
    case "agent":
      add(c, "remote-flag-missing", undefined, `agents following this now run ${what} against the local stack; write ${code("--remote")} where the hosted project is meant`, "warning");
      return;
    case "script":
      add(c, "remote-flag-missing", undefined, `${what} targets the local stack in v3 (v2 used the linked project); add ${code("--remote")} if this script should reach the hosted project`, "note");
  }
}

function machineReadable(c: Ctx): boolean {
  const o = flag(c, "-o", "--output");
  const of = flag(c, "--output-format");
  return (o?.value !== undefined && /^(json|yaml|toml|env)$/.test(o.value)) || (of?.value !== undefined && /^(json|stream-json)$/.test(of.value));
}

function yesMissing(c: Ctx): void {
  const p = c.path;
  // A dry run changes nothing, so there is nothing to confirm.
  if (hasFlag(c, "--dry-run")) return;
  if (p === "db query" && hasFlag(c, "--read-only")) return;
  // With no names it fails before asking; secrets-unset-without-names says what to decide first.
  if (p === "secrets unset" && c.cmd.positionals.length === 0 && !hasFlag(c, "--all")) return;
  const remoteTarget = hasFlag(c, "--remote", "--linked", "--project-ref", "--db-url");
  const hosted = ALWAYS_HOSTED.has(p) || (MUTATE_TARGET.has(p) && (remoteTarget || willAddRemote(c) || p === "pull"));
  if (!hosted) return;
  const yesEnv = c.inv.envPrefix.get("SUPABASE_YES");
  if (hasFlag(c, "--yes") || (yesEnv !== undefined && TRUTHY.test(yesEnv)) || c.facts.exportsYes.has(c.region.file.path)) return;

  const what = code(`supabase ${p}`);
  const maybe = p === "db pull" ? " when it updates the remote migration history" : "";
  if (c.region.context === "ci") {
    const severity: Severity = p === "db pull" ? "warning" : "error";
    add(c, "yes-flag-missing", [append(c, "--yes", 1)], `${what} changes the hosted project and asks first in v3${maybe}; in CI it fails with HostedMutationConsentRequiredError unless you pass ${code("--yes")}`, severity);
  } else if (c.region.context === "agent") {
    add(c, "yes-flag-missing", undefined, `an agent running ${what} never gets a prompt in v3: it fails with HostedMutationConsentRequiredError and is told to ask you before passing ${code("--yes")}; say here whether that is allowed`, "warning");
  } else if (machineReadable(c)) {
    add(c, "yes-flag-missing", undefined, `${what} with machine-readable output can't prompt in v3 and fails with HostedMutationConsentRequiredError; pass ${code("--yes")}`, "warning");
  } else {
    add(c, "yes-flag-missing", undefined, `${what} now asks for confirmation (default No); fine in a terminal, but pass ${code("--yes")} if this runs unattended`, "note");
  }
}

function remoteWithoutEquals(c: Ctx): void {
  const remote = c.cmd.flags.find((f) => f.name === "--remote" && !f.attached);
  if (!remote) return;
  const next: Token | undefined = c.inv.args[remote.index + 1];
  if (!next || next.redirect || next.value.startsWith("-")) return;
  const value = next.value;
  const clear = PROJECT_REF.test(value) || PG_URL.test(value) || VARIABLE.test(value);
  const edits = clear ? [{ start: c.inv.args[remote.index]!.end, end: next.start, text: "=" }] : undefined;
  const hint = clear ? "" : ` (if ${code(value)} is an argument, not the target, move ${code("--remote")} to the end instead)`;
  add(c, "remote-value-without-equals", edits, `${code(`--remote ${next.raw}`)}: a value must be attached with =, write ${code(`--remote=${next.raw}`)}${hint}`);
}

function smallerRules(c: Ctx): void {
  const p = c.path;
  if (p === "secrets unset" && c.cmd.positionals.length === 0 && !hasFlag(c, "--all")) {
    add(c, "secrets-unset-without-names", undefined, `${code("supabase secrets unset")} with no names used to remove every secret; v3 fails instead. Name the secrets, or pass ${code("--all")} if that is what you mean`);
  }

  const password = flag(c, "--password", "-p");
  if (password) {
    const remote = flag(c, "--remote");
    const urlTarget = hasFlag(c, "--db-url") || (remote?.value !== undefined && PG_URL.test(remote.value));
    const passwordCommands = ["db push", "db pull", "db dump", "db schema declarative generate", "migration list", "migration repair"];
    if (urlTarget && passwordCommands.includes(p)) {
      add(c, "password-with-url-target", undefined, `${code(`${password.name}`)} with a database URL exits 1 in v3 (DbPasswordFlagsError); put the password in the URL`);
    } else if (p === "migration squash" && !hasFlag(c, "--remote", "--linked", "--project-ref", "--db-url")) {
      add(c, "password-with-url-target", undefined, `${code("migration squash")} targets the local database by default in v3, so ${code(password.name)} also needs ${code("--remote")}`);
    }
  }

  if (p === "db diff" && hasFlag(c, "--remote") && hasFlag(c, "--from", "--to")) {
    add(c, "diff-remote-with-from-to", undefined, `${code("db diff")} rejects ${code("--remote")} together with ${code("--from")}/${code("--to")}; use ${code("--from=remote")} or ${code("--to=remote")}`);
  }

  if (p === "db diff" && c.facts.declarativeSchemas && !c.facts.migraPinned && !hasFlag(c, "--use-migra")) {
    add(c, "declarative-diff", undefined, `${code("db diff")} no longer reads supabase/schemas under pg-delta (the v3 default); generate migrations with ${code("supabase db schema declarative sync")}`);
  }

  const override = c.cmd.flags.find((f) => f.name === "--override-name" && /^inbucket\.url(=|$)/.test(f.value ?? ""));
  if (override) {
    const t = c.inv.args[override.valueIndex ?? override.index]!;
    const at = t.start + t.raw.lastIndexOf("inbucket.url");
    add(c, "inbucket-url", [{ start: at, end: at + "inbucket.url".length, text: "mailpit.url" }], `${code("--override-name inbucket.url")} fails in v3; use ${code("--override-name mailpit.url")}`, "error");
  }
}
