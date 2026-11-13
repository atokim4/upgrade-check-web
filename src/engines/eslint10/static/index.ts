/**
 * Detect-only checks for an ESLint 9 -> 10 upgrade that need no install and
 * no ESLint: they read file contents only, so the same engine runs in the
 * CLI and in a browser (files fetched from GitHub).
 */
import semver from "semver";
import { findEslintCommand } from "../collector/shell.js";

export type StaticSeverity = "error" | "warning" | "info";

export interface StaticFinding {
  id: string;
  severity: StaticSeverity;
  file: string;
  line?: number;
  message: string;
  fix?: string;
  docs: string;
}

/** Repo-relative path -> file content. Only the files the checks care about need to be present. */
export type RepoFiles = Record<string, string>;

const DOCS = "https://eslint.org/docs/latest/use/migrate-to-10.0.0";
const ESLINTRC = /(^|\/)(\.eslintrc(\.(js|cjs|yaml|yml|json))?)$/;
const FLAT = /(^|\/)eslint\.config\.[cm]?[jt]s$/;
const TS_FLAT = /(^|\/)eslint\.config\.[cm]?ts$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const REMOVED_CLI_FLAGS = ["--env", "--no-eslintrc", "--ignore-path", "--resolve-plugins-relative-to", "--rulesdir"];
/** Node.js versions ESLint 10 supports (package.json engines of eslint 10.x). */
export const ESLINT10_NODE = "^20.19.0 || ^22.13.0 || >=24";

/** The complement of ESLINT10_NODE, as ranges with a readable label. */
const UNSUPPORTED_NODE = [
  { range: "<20.19.0", label: "Node below 20.19" },
  { range: ">=21.0.0 <22.0.0", label: "Node 21" },
  { range: ">=22.0.0 <22.13.0", label: "Node 22.0 to 22.12" },
  { range: ">=23.0.0 <24.0.0", label: "Node 23" },
];

const skip = (file: string) => /(^|\/)(node_modules|dist|build|coverage|vendor)\//.test(file);

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function depRange(pkg: Record<string, unknown>, name: string): string | undefined {
  for (const field of ["devDependencies", "dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field] as Record<string, unknown> | undefined;
    if (deps && typeof deps[name] === "string") return deps[name] as string;
  }
  return undefined;
}

/** Does a dependency range let ESLint 10 install? Non-semver ranges (workspace:, catalog:) count as unknown. */
function allowsMajor(range: string | undefined, major: number): boolean | undefined {
  if (!range) return undefined;
  const valid = semver.validRange(range);
  if (!valid) return undefined;
  return semver.intersects(valid, `>=${major}.0.0-0 <${major + 1}.0.0`, { includePrerelease: true });
}

/** A Node version spec from CI or .nvmrc that would run below what ESLint 10 needs. */
export function unsupportedNode(spec: string): string | null {
  const v = spec.trim().replace(/^v/, "").replace(/["']/g, "");
  if (!v || /^(lts|latest|node|current|stable|\$\{\{)/i.test(v)) return null;
  const parts = v.replace(/\.x$/i, "").split(".");
  const major = Number(parts[0]);
  if (!Number.isInteger(major)) return null;
  if (parts.length === 1) {
    // A bare major resolves to its newest release.
    if (major < 20 || major === 21 || major === 23) return `Node ${major}`;
    return null;
  }
  const full = semver.coerce(v);
  if (!full) return null;
  return semver.satisfies(full, ESLINT10_NODE) ? null : `Node ${full.version}`;
}

interface Context {
  files: RepoFiles;
  paths: string[];
  packages: Array<{ file: string; pkg: Record<string, unknown> }>;
  /** Some package.json lets eslint 10 in. */
  targetsTen: boolean;
  out: StaticFinding[];
}

function add(ctx: Context, finding: StaticFinding): void {
  ctx.out.push(finding);
}

function checkConfigFormat(ctx: Context): void {
  const eslintrc = ctx.paths.filter((p) => ESLINTRC.test(p) && !skip(p));
  const pkgConfigs = ctx.packages.filter((p) => "eslintConfig" in p.pkg).map((p) => `${p.file}#eslintConfig`);
  const legacy = [...eslintrc, ...pkgConfigs];
  const flat = ctx.paths.filter((p) => FLAT.test(p) && !skip(p));
  if (legacy.length && !flat.length) {
    add(ctx, {
      id: "eslintrc-only",
      severity: ctx.targetsTen ? "error" : "warning",
      file: legacy[0] as string,
      message: ctx.targetsTen
        ? `Only eslintrc config found (${legacy.join(", ")}). ESLint 10 cannot read it and exits 2 with "couldn't find an eslint.config.* file" (with --no-config-lookup it lints with no rules at all).`
        : `Only eslintrc config found (${legacy.join(", ")}). It must be ported to eslint.config.js before ESLint 10.`,
      fix: "Port with `npx @eslint/migrate-config <file>` and review the result; the config codemod is only partial.",
      docs: `${DOCS}#remove-eslintrc`,
    });
  } else if (legacy.length && flat.length) {
    add(ctx, {
      id: "eslintrc-leftover",
      severity: "info",
      file: legacy[0] as string,
      message: `Flat config exists, so ${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} not read. Anything only set there (overrides, env, ignorePatterns) is not applied.`,
      docs: `${DOCS}#remove-eslintrc`,
    });
  }
  const roots = flat.filter((p) => !p.includes("/"));
  const nested = flat.filter((p) => p.includes("/"));
  if (nested.length) {
    add(ctx, {
      id: "nested-config-lookup",
      severity: roots.length ? "warning" : "info",
      file: nested[0] as string,
      message: roots.length
        ? `${nested.length} nested eslint.config file${nested.length === 1 ? "" : "s"} (${nested.slice(0, 4).join(", ")}). ESLint 9 used the root config for every file when run from the root; ESLint 10 uses the nearest config to each file, so those folders switch config.`
        : `Config files only in subfolders (${nested.slice(0, 4).join(", ")}). ESLint 10 finds them per file; ESLint 9 needed eslint to run inside each folder.`,
      fix: "Keep the old behaviour with an explicit `--config eslint.config.js`, or check that each nested config is complete.",
      docs: `${DOCS}#config-lookup-from-file`,
    });
  }
}

function checkIgnoreFile(ctx: Context): void {
  for (const file of ctx.paths.filter((p) => /(^|\/)\.eslintignore$/.test(p) && !skip(p))) {
    const patterns = (ctx.files[file] ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const flat = ctx.paths.some((p) => FLAT.test(p));
    if (!flat && !ctx.targetsTen) continue;
    add(ctx, {
      id: "eslintignore",
      severity: "warning",
      file,
      message: `${file} (${patterns.length} pattern${patterns.length === 1 ? "" : "s"}) is not read by flat config. ESLint 9 and 10 only print an ESLintIgnoreWarning and lint those paths.`,
      fix: `Move them into the config: \`globalIgnores(${JSON.stringify(patterns.slice(0, 6))}${patterns.length > 6 ? " /* ... */" : ""})\` from "eslint/config", then delete ${file}.`,
      docs: "https://eslint.org/docs/latest/use/configure/migration-guide#ignore-files",
    });
  }
}

const ENV_COMMENT = /\/\*\s*eslint-env\s+([^*]*?)\s*\*\//g;

function checkEnvComments(ctx: Context): void {
  for (const file of ctx.paths) {
    if (!SOURCE.test(file) || skip(file)) continue;
    const text = ctx.files[file] ?? "";
    if (!text.includes("eslint-env")) continue;
    for (const m of text.matchAll(ENV_COMMENT)) {
      const envs = (m[1] ?? "").split(/\s*--\s*/)[0]?.split(/[\s,]+/).filter(Boolean) ?? [];
      add(ctx, {
        id: "eslint-env-comment",
        severity: ctx.targetsTen ? "error" : "warning",
        file,
        line: lineOf(text, m.index ?? 0),
        message: `/* eslint-env ${envs.join(", ")} */ is an error in ESLint 10 (and ignored by flat config in ESLint 9).`,
        fix: `Remove the comment and add the globals in config, e.g. \`languageOptions: { globals: { ...globals.${envs[0] ?? "node"} } }\` for this file.`,
        docs: `${DOCS}#eslint-env-comments`,
      });
    }
  }
}

function checkNode(ctx: Context): void {
  for (const { file, pkg } of ctx.packages) {
    const range = (pkg.engines as Record<string, unknown> | undefined)?.node;
    if (typeof range !== "string") continue;
    const valid = semver.validRange(range);
    if (!valid) continue;
    const gap = UNSUPPORTED_NODE.find((g) => semver.intersects(valid, g.range));
    if (gap) {
      add(ctx, {
        id: "node-engine",
        severity: "warning",
        file,
        message: `engines.node "${range}" allows ${gap.label}; ESLint 10 needs ${ESLINT10_NODE}.`,
        docs: `${DOCS}#drop-old-node`,
      });
    }
  }
  for (const file of ctx.paths.filter((p) => /(^|\/)\.(nvmrc|node-version)$/.test(p))) {
    const bad = unsupportedNode((ctx.files[file] ?? "").split("\n")[0] ?? "");
    if (bad) add(ctx, { id: "node-version-file", severity: "warning", file, line: 1, message: `${file} pins ${bad}; ESLint 10 needs ${ESLINT10_NODE}.`, docs: `${DOCS}#drop-old-node` });
  }
  for (const file of ctx.paths.filter((p) => WORKFLOW.test(p))) {
    const text = ctx.files[file] ?? "";
    for (const m of text.matchAll(/^\s*-?\s*(node-version|node|node_version)\s*:\s*(.+)$/gm)) {
      const raw = (m[2] ?? "").replace(/#.*$/, "").trim();
      const values = raw.startsWith("[") ? raw.replace(/[[\]]/g, "").split(",") : [raw];
      const bad = values.map((v) => unsupportedNode(v)).filter((v): v is string => v !== null);
      if (bad.length) {
        add(ctx, {
          id: "ci-node",
          severity: "warning",
          file,
          line: lineOf(text, m.index ?? 0),
          message: `CI runs ${bad.join(", ")}; ESLint 10 needs ${ESLINT10_NODE}. Fine if lint never runs on that version.`,
          docs: `${DOCS}#drop-old-node`,
        });
      }
    }
  }
}

function lockedVersion(ctx: Context, name: string): string | undefined {
  const lock = parseJson(ctx.files["package-lock.json"]);
  const entry = (lock?.packages as Record<string, { version?: string }> | undefined)?.[`node_modules/${name}`];
  return entry?.version;
}

function checkJiti(ctx: Context): void {
  const tsConfig = ctx.paths.find((p) => TS_FLAT.test(p) && !skip(p));
  if (!tsConfig) return;
  const locked = lockedVersion(ctx, "jiti");
  const range = ctx.packages.map((p) => depRange(p.pkg, "jiti")).find(Boolean);
  if (locked && semver.valid(locked) && semver.lt(locked, "2.2.0")) {
    add(ctx, { id: "jiti", severity: "error", file: "package-lock.json", message: `${tsConfig} needs jiti >= 2.2.0 with ESLint 10; the lockfile has ${locked}.`, fix: "npm i -D jiti@^2.2.0", docs: `${DOCS}#drop-old-jiti` });
  } else if (range && semver.validRange(range) && semver.lt(semver.minVersion(range) ?? "0.0.0", "2.2.0")) {
    add(ctx, { id: "jiti", severity: "warning", file: "package.json", message: `${tsConfig} needs jiti >= 2.2.0 with ESLint 10; package.json allows ${range}.`, fix: "npm i -D jiti@^2.2.0", docs: `${DOCS}#drop-old-jiti` });
  } else if (!range && !locked) {
    add(ctx, {
      id: "jiti",
      severity: "info",
      file: tsConfig,
      message: `${tsConfig} is TypeScript and jiti is not a direct dependency. ESLint 10 loads TS configs with jiti >= 2.2.0 (or native type stripping behind a flag); a hoisted older jiti breaks loading.`,
      docs: `${DOCS}#drop-old-jiti`,
    });
  }
}

function checkScriptsAndCi(ctx: Context): void {
  const scriptFiles: Array<{ file: string; text: string }> = ctx.packages.map(({ file, pkg }) => ({
    file,
    text: Object.values((pkg.scripts ?? {}) as Record<string, string>).join("\n"),
  }));
  for (const file of ctx.paths.filter((p) => WORKFLOW.test(p))) {
    scriptFiles.push({ file, text: ctx.files[file] ?? "" });
  }
  for (const { file, text } of scriptFiles) {
    const raw = ctx.files[file] ?? text;
    const flatEnv = /ESLINT_USE_FLAT_CONFIG\s*[=:]\s*["']?(true|false)/.exec(text);
    if (flatEnv) {
      add(ctx, {
        id: "flat-config-env",
        severity: flatEnv[1] === "false" ? "error" : "info",
        file,
        line: lineOf(raw, Math.max(0, raw.indexOf("ESLINT_USE_FLAT_CONFIG"))),
        message:
          flatEnv[1] === "false"
            ? "ESLINT_USE_FLAT_CONFIG=false keeps ESLint 9 on eslintrc. ESLint 10 ignores the variable and looks for eslint.config.*."
            : "ESLINT_USE_FLAT_CONFIG has no effect in ESLint 10; it can go.",
        docs: `${DOCS}#remove-eslintrc`,
      });
    }
    if (text.includes("v10_config_lookup_from_file")) {
      add(ctx, {
        id: "lookup-flag",
        severity: "error",
        file,
        line: lineOf(raw, Math.max(0, raw.indexOf("v10_config_lookup_from_file"))),
        message: "The v10_config_lookup_from_file flag was removed; ESLint 10 throws when it is passed.",
        fix: "Delete the flag (--flag v10_config_lookup_from_file / ESLINT_FLAGS).",
        docs: `${DOCS}#config-lookup-from-file`,
      });
    }
    for (const line of text.split("\n")) {
      // Only the eslint command's own arguments: `eslint . && jest --env=jsdom` is fine.
      const args = findEslintCommand(line.replace(/^\s*-?\s*(run:\s*)?/, ""))?.args;
      if (!args) continue;
      const removed = REMOVED_CLI_FLAGS.filter((f) => args.some((a) => a === f || a.startsWith(`${f}=`)));
      if (removed.length) {
        add(ctx, {
          id: "removed-cli-flag",
          severity: ctx.targetsTen ? "error" : "warning",
          file,
          line: lineOf(raw, Math.max(0, raw.indexOf(removed[0] as string))),
          message: `${removed.join(", ")} ${removed.length === 1 ? "is an eslintrc-only option" : "are eslintrc-only options"}; the ESLint 10 CLI rejects ${removed.length === 1 ? "it" : "them"} ("${line.trim().slice(0, 120)}").`,
          docs: `${DOCS}#remove-eslintrc`,
        });
      }
    }
  }
}

/**
 * Packages an ESLint 9 install brings in and an ESLint 10 install no longer does: @eslint/js and
 * @eslint/eslintrc are dependencies of eslint 9, and globals ^14 comes in through @eslint/eslintrc.
 */
const DROPPED_DEPS: Record<string, { range: string; via: string }> = {
  "@eslint/js": { range: "^10.0.0", via: "as its own dependency" },
  "@eslint/eslintrc": { range: "^3.3.7", via: "as its own dependency" },
  globals: { range: "^14.0.0", via: "through @eslint/eslintrc (unless another package also pulls it in)" },
};

function checkUndeclaredPackages(ctx: Context): void {
  const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
  for (const file of ctx.paths.filter((p) => FLAT.test(p) && !skip(p))) {
    const text = ctx.files[file] ?? "";
    // Node resolves a bare import from the config's folder upwards, so any ancestor package.json may declare it.
    const dir = dirOf(file);
    const ancestors = ctx.packages.filter((p) => {
      const d = dirOf(p.file);
      return d === "" || dir === d || dir.startsWith(`${d}/`);
    });
    for (const [name, { range, via }] of Object.entries(DROPPED_DEPS)) {
      const m = new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)["']${name.replace("/", "\\/")}(?:/[^"']*)?["']`).exec(text);
      if (!m || ancestors.some((p) => depRange(p.pkg, name) !== undefined)) continue;
      add(ctx, {
        id: "undeclared-eslint-package",
        severity: ctx.targetsTen ? "error" : "warning",
        file,
        line: lineOf(text, m.index),
        message: `${file} imports ${name}, but no package.json declares it. ESLint 9 installs ${name} ${via} and ESLint 10 does not, so after the bump the config can fail with "Cannot find package '${name}'". The migration guide does not list this.`,
        fix: `Add \`"${name}": "${range}"\` to devDependencies.`,
        docs: DOCS,
      });
    }
  }
}

const TS_ESLINT_PACKAGES = ["typescript-eslint", "@typescript-eslint/parser", "@typescript-eslint/eslint-plugin", "@typescript-eslint/utils"];

/**
 * typescript-eslint before 8.54.0 subclasses LegacyESLint from eslint/use-at-your-own-risk, which ESLint 10
 * removed, so loading it crashes with "Class extends value undefined". 8.56.0 is the first release whose peer
 * range includes ESLint 10 (checked in the published @typescript-eslint/utils packages).
 */
function checkTypescriptEslint(ctx: Context): void {
  if (!ctx.targetsTen) return;
  for (const name of TS_ESLINT_PACKAGES) {
    const locked = lockedVersion(ctx, name);
    const declared = ctx.packages.map((p) => ({ file: p.file, range: depRange(p.pkg, name) })).find((d) => d.range);
    const valid = declared?.range ? semver.validRange(declared.range) : null;
    const version = locked && semver.valid(locked) ? locked : valid ? semver.minVersion(valid)?.version : undefined;
    if (!version || semver.gte(version, "8.56.0") || semver.lt(version, "8.0.0")) continue;
    const source = locked ? `the lockfile has ${locked}` : `${declared?.file} allows ${declared?.range}`;
    // Without an npm lockfile the version is only the lowest the range allows; an install may well get a newer one.
    const crashes = semver.lt(version, "8.54.0") && Boolean(locked);
    add(ctx, {
      id: "typescript-eslint-version",
      severity: crashes ? "error" : "warning",
      file: locked ? "package-lock.json" : (declared?.file ?? "package.json"),
      message: crashes
        ? `${name}: ${source}. Releases before 8.54.0 extend LegacyESLint, which ESLint 10 removed, so linting crashes with "Class extends value undefined is not a constructor or null".`
        : locked
          ? `${name}: ${source}. Its peer range stops at ESLint 9, so npm ci fails with ERESOLVE next to eslint 10, and some rules still read context.parserOptions (8.54.0's @typescript-eslint/no-deprecated crashes on ESLint 10).`
          : `${name}: ${source}. Check the installed version: below 8.54.0 it crashes on ESLint 10 ("Class extends value undefined"), and only 8.56.0+ lists ESLint 10 as a supported peer.`,
      fix: `Upgrade ${name} to ^8.56.0 together with eslint.`,
      docs: "https://typescript-eslint.io/users/dependency-versions",
    });
  }
}

function checkConfigContents(ctx: Context): void {
  for (const file of ctx.paths.filter((p) => (FLAT.test(p) || ESLINTRC.test(p)) && !skip(p))) {
    const text = ctx.files[file] ?? "";
    const radix = /["']?radix["']?\s*:\s*\[\s*["']?(?:error|warn|2|1)["']?\s*,\s*["'](always|as-needed)["']/.exec(text);
    if (radix) {
      add(ctx, {
        id: "radix-option",
        severity: radix[1] === "as-needed" ? "warning" : "info",
        file,
        line: lineOf(text, radix.index),
        message:
          radix[1] === "as-needed"
            ? 'radix "as-needed" is deprecated and does nothing in ESLint 10: parseInt() without a radix is now reported everywhere.'
            : 'radix "always" is deprecated in ESLint 10 (it is the only behaviour now); the option can go.',
        docs: `${DOCS}#radix`,
      });
    }
    const jsxUses = /["']((?:@eslint-react|react)\/jsx-uses-vars)["']/.exec(text);
    if (jsxUses) {
      add(ctx, {
        id: "jsx-uses-vars",
        severity: "info",
        file,
        line: lineOf(text, jsxUses.index),
        message: `${jsxUses[1]} is not needed with ESLint 10, which tracks JSX references itself.`,
        docs: `${DOCS}#jsx-reference-tracking`,
      });
    }
  }
}

function checkApiUsage(ctx: Context): void {
  for (const file of ctx.paths) {
    if (!SOURCE.test(file) || skip(file)) continue;
    const text = ctx.files[file] ?? "";
    if (!text.includes("eslint")) continue;
    const m = /\b(LegacyESLint|FlatESLint)\b|configType\s*:\s*["']eslintrc["']/.exec(text);
    if (!m || !/from\s+["']eslint(\/use-at-your-own-risk)?["']|require\(\s*["']eslint/.test(text)) continue;
    add(ctx, {
      id: "removed-api",
      severity: "error",
      file,
      line: lineOf(text, m.index),
      message: m[1] ? `${m[1]} was removed in ESLint 10; use ESLint.` : 'Linter configType "eslintrc" was removed in ESLint 10.',
      fix: "npx codemod @eslint/v9-to-v10-linter-api",
      docs: `${DOCS}#remove-eslintrc`,
    });
  }
}

/** Which files the checks read: lets a browser fetch only those. */
export function wantsFile(file: string): boolean {
  return (
    /(^|\/)package\.json$/.test(file) ||
    file === "package-lock.json" ||
    ESLINTRC.test(file) ||
    FLAT.test(file) ||
    /(^|\/)\.eslintignore$/.test(file) ||
    /(^|\/)\.(nvmrc|node-version)$/.test(file) ||
    WORKFLOW.test(file) ||
    SOURCE.test(file)
  );
}

export function staticChecks(files: RepoFiles): StaticFinding[] {
  const paths = Object.keys(files).filter((p) => !p.split("/").includes("node_modules")).sort();
  const packages = paths
    .filter((p) => /(^|\/)package\.json$/.test(p))
    .map((file) => ({ file, pkg: parseJson(files[file]) }))
    .filter((p): p is { file: string; pkg: Record<string, unknown> } => p.pkg !== null);
  const targetsTen = packages.some((p) => allowsMajor(depRange(p.pkg, "eslint"), 10) === true);
  const ctx: Context = { files, paths, packages, targetsTen, out: [] };
  checkConfigFormat(ctx);
  checkIgnoreFile(ctx);
  checkEnvComments(ctx);
  checkNode(ctx);
  checkJiti(ctx);
  checkScriptsAndCi(ctx);
  checkConfigContents(ctx);
  checkUndeclaredPackages(ctx);
  checkTypescriptEslint(ctx);
  checkApiUsage(ctx);
  const order: Record<StaticSeverity, number> = { error: 0, warning: 1, info: 2 };
  return ctx.out.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * With a lint run of the same tree at hand, drop eslint-env findings for files ESLint does not lint there:
 * ESLint 10 only reports the comment in files it lints. `fileStatus` maps repo-relative paths to the run's
 * status; files it does not know, and files whose run crashed, stay in.
 */
export function scopeToLintedFiles(findings: StaticFinding[], fileStatus: Record<string, string>): StaticFinding[] {
  const notLinted = new Set(["ignored", "unmatched", "outside"]);
  const skipped = findings.filter((f) => f.id === "eslint-env-comment" && notLinted.has(fileStatus[f.file] ?? ""));
  if (!skipped.length) return findings;
  const kept = findings.filter((f) => !skipped.includes(f));
  const sample = skipped[0] as StaticFinding;
  kept.push({
    id: "eslint-env-comment",
    severity: "info",
    file: sample.file,
    line: sample.line,
    message: `${skipped.length}${kept.some((f) => f.id === "eslint-env-comment") ? " more" : ""} /* eslint-env */ comment${skipped.length === 1 ? " is" : "s are"} in files this lint run does not lint (ignored or not matched), so ESLint 10 does not report ${skipped.length === 1 ? "it" : "them"}.`,
    docs: sample.docs,
  });
  return kept;
}

