import { checkCorepack, checkPackageManagerInstalled, checkTransformTypesFlag, checkYarnInImage } from "./checks/runtime.ts";
import { checkSourceApis } from "./checks/source.ts";
import { checkDependencyEngines, checkEngines, checkFloating, checkMismatch, checkNativeAddons } from "./checks/versions.ts";
import { checkNodeModulesCacheKey, checkSetupNodeCache } from "./checks/workflow.ts";
import { buildModel } from "./contexts.ts";
import { describe } from "./node-version.ts";
import { RULES } from "./rules.ts";
import type { Repo } from "./sources.ts";
import { SEVERITY_ORDER, type Finding, type RuleMeta, type Severity } from "./types.ts";

export interface ScanOptions {
  /** Rule ids to skip. */
  exclude?: readonly string[];
  /** Major to pin floating Node versions to under --fix. */
  pin?: number;
}

export interface ScanResult {
  root: string;
  findings: Finding[];
  rules: readonly RuleMeta[];
  /** How many files of each kind were read. */
  scanned: Record<string, number>;
  /** The repo's own Node pin, described. */
  repoPin: string;
  truncated: boolean;
}

/** Scans files that are already loaded. Pure: the CLI feeds it from disk, the web page from GitHub. */
export function scanRepo(repo: Repo, options: ScanOptions = {}): ScanResult {
  const root = repo.root;
  const exclude = options.exclude ?? [];
  const model = buildModel(repo.files);
  const findings: Finding[] = [
    ...checkCorepack(model),
    ...checkYarnInImage(model),
    ...checkPackageManagerInstalled(model),
    ...checkSetupNodeCache(model),
    ...checkTransformTypesFlag(model),
    ...checkFloating(model, { pin: options.pin }),
    ...checkEngines(model),
    ...checkMismatch(model),
    ...checkDependencyEngines(model),
    ...checkNativeAddons(model),
    ...checkNodeModulesCacheKey(model),
    ...checkSourceApis(model),
  ].filter((f) => !exclude.includes(f.rule));

  const order = new Map(RULES.map((r, i) => [r.id, i]));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || (order.get(a.rule) ?? 0) - (order.get(b.rule) ?? 0));

  const scanned: Record<string, number> = {};
  for (const f of repo.files) scanned[f.kind] = (scanned[f.kind] ?? 0) + 1;
  return { root, findings, rules: RULES.filter((r) => !exclude.includes(r.id)), scanned, repoPin: describe(model.repoPin), truncated: repo.truncated };
}

export function failsAt(findings: readonly Finding[], level: Severity): boolean {
  return findings.some((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[level]);
}

export function counts(findings: readonly Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, note: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}
