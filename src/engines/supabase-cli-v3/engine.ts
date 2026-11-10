import { checkCommands } from "./checks/commands.ts";
import { checkConfigJson, checkConfigToml, configFacts } from "./checks/config.ts";
import {
  checkEnvFiles, checkFunctionImportMaps, checkProjectIdTarget, checkRenames, checkSetupCli, envOverrides, exportsYes, lockfilePin, setsExperimental,
} from "./checks/repo.ts";
import { RULES } from "./rules.ts";
import { findInvocations, parseCommand, type ParsedCommand } from "./shell.ts";
import { ciReach, regionsOf, type Region, type Repo } from "./sources.ts";
import { SEVERITY_ORDER, type Finding, type RuleMeta, type Severity } from "./types.ts";

export interface ScanResult {
  root: string;
  findings: Finding[];
  rules: readonly RuleMeta[];
  /** How many files of each kind were read. */
  scanned: Record<string, number>;
  /** Files CI reaches through `npm run …`, `./script.sh` or `make`. */
  ciReached: string[];
  truncated: boolean;
}

/**
 * Scans files that are already loaded. `read` returns any other file of the repo by relative path (the lockfiles
 * the setup-cli check looks at), or undefined. Pure: the CLI feeds it from disk, the web page from GitHub.
 */
export function scanRepo(repo: Repo, read: (path: string) => string | undefined, skip: readonly string[] = []): ScanResult {
  const root = repo.root;
  const reach = ciReach(repo.files);
  const regions: Region[] = repo.files.flatMap((f) => regionsOf(f, reach.scripts, reach.files));

  // One pass over every invocation for the facts that rules need across files.
  const commands = new Map<string, ParsedCommand[]>();
  for (const r of regions) {
    const list = commands.get(r.file.path) ?? [];
    for (const inv of findInvocations(r.lexText, r.start, r.end)) list.push(parseCommand(inv.args));
    commands.set(r.file.path, list);
  }
  const all = [...commands.values()].flat();
  const pathsOf = (file: string) => (commands.get(file) ?? []).map((c) => c.path.join(" "));
  const files = repo.files;
  const cfg = configFacts(files, repo.paths);

  const findings: Finding[] = [
    ...checkCommands(regions, {
      startsLocalStack: new Set(files.filter((f) => pathsOf(f.path).some((p) => p === "start" || p === "db start")).map((f) => f.path)),
      exportsYes: new Set(files.filter(exportsYes).map((f) => f.path)),
      setsExperimental: new Set(files.filter(setsExperimental).map((f) => f.path)),
      ...cfg,
    }),
    ...files.filter((f) => f.kind === "config-toml").flatMap((f) =>
      checkConfigToml(f, { runsConfigPush: all.some((c) => c.path.join(" ") === "config push"), envOverrides: envOverrides(files) }),
    ),
    ...files.filter((f) => f.kind === "config-json").flatMap(checkConfigJson),
    ...checkRenames(files),
    ...checkEnvFiles(files),
    ...checkFunctionImportMaps(repo.paths),
    ...checkSetupCli(files, lockfilePin(repo.paths, read)),
    ...checkProjectIdTarget(files, commands),
  ].filter((f) => !skip.includes(f.rule));

  const order = new Map(RULES.map((r, i) => [r.id, i]));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || (order.get(a.rule) ?? 0) - (order.get(b.rule) ?? 0));

  const scanned: Record<string, number> = {};
  for (const f of files) scanned[f.kind] = (scanned[f.kind] ?? 0) + 1;
  return {
    root,
    findings,
    rules: RULES.filter((r) => !skip.includes(r.id)),
    scanned,
    ciReached: [...reach.files, ...[...reach.scripts].map((s) => `npm script "${s}"`)],
    truncated: repo.truncated,
  };
}

export function failsAt(findings: readonly Finding[], level: Severity): boolean {
  return findings.some((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[level]);
}

export function counts(findings: readonly Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, note: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
