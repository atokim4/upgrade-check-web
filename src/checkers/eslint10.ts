import { staticChecks, wantsFile, type StaticFinding } from "../engines/eslint10/static/index.ts";
import versions from "../engines/versions.json";
import type { LoadedRepo } from "../lib/loader.ts";
import type { CheckerReport, Finding, Severity } from "../lib/types.ts";

const REPO_URL = "https://github.com/atokim4/eslint10-parity";
const SEVERITY: Record<StaticFinding["severity"], Severity> = { error: "error", warning: "warning", info: "note" };

interface RuleInfo {
  title: string;
  why: string;
}

/** One entry per check id of the engine (test/eslint10.test.ts keeps them in step). */
export const RULES: Record<string, RuleInfo> = {
  "eslintrc-only": {
    title: "eslintrc config with ESLint 10",
    why: "ESLint 10 only reads eslint.config.* files. With an .eslintrc and no flat config it stops with \"Could not find config file\", so nothing is linted.",
  },
  "eslintrc-leftover": {
    title: "eslintrc file next to a flat config",
    why: "Flat config never reads it, so anything set only there (overrides, env, ignorePatterns) is not applied.",
  },
  "nested-config-lookup": {
    title: "Several eslint.config files",
    why: "ESLint 10 looks up the config from each linted file's folder, so a nested eslint.config.* now takes over its folder.",
  },
  eslintignore: {
    title: ".eslintignore is not read",
    why: "Flat config does not read .eslintignore. ESLint only prints an ESLintIgnoreWarning and lints the paths it listed.",
  },
  "eslint-env-comment": {
    title: "/* eslint-env */ comment",
    why: "ESLint 10 reports these comments as errors; flat config in ESLint 9 already ignored them.",
  },
  "flat-config-env": {
    title: "ESLINT_USE_FLAT_CONFIG in scripts or CI",
    why: "ESLint 10 ignores the variable, so ESLINT_USE_FLAT_CONFIG=false no longer brings eslintrc back.",
  },
  "lookup-flag": {
    title: "Removed config lookup flag",
    why: "The v10_config_lookup_from_file flag is the default in ESLint 10 and passing it is an error.",
  },
  "removed-cli-flag": {
    title: "eslintrc-only CLI flag",
    why: "The ESLint 10 CLI rejects eslintrc-only options such as --ext, --resolve-plugins-relative-to or --rulesdir.",
  },
  "node-engine": {
    title: "engines.node allows a Node ESLint 10 does not support",
    why: "ESLint 10 needs Node ^20.19.0, ^22.13.0 or >=24.",
  },
  "node-version-file": {
    title: "Pinned Node too old for ESLint 10",
    why: "ESLint 10 needs Node ^20.19.0, ^22.13.0 or >=24.",
  },
  "ci-node": {
    title: "CI runs a Node ESLint 10 does not support",
    why: "ESLint 10 needs Node ^20.19.0, ^22.13.0 or >=24.",
  },
  jiti: {
    title: "jiti too old for eslint.config.ts",
    why: "ESLint 10 loads TypeScript configs with jiti 2.2.0 or newer.",
  },
  "undeclared-eslint-package": {
    title: "Config imports a package only ESLint 9 installed",
    why: "ESLint 9 brought in @eslint/js, @eslint/eslintrc and (through it) globals. ESLint 10 does not, so an undeclared import fails with \"Cannot find package\".",
  },
  "typescript-eslint-version": {
    title: "typescript-eslint too old for ESLint 10",
    why: "Before 8.54.0 it extends LegacyESLint, which ESLint 10 removed; 8.56.0 is the first release with ESLint 10 in its peer range.",
  },
  "radix-option": {
    title: "Deprecated radix option",
    why: "Both radix options are deprecated in ESLint 10, and \"as-needed\" does nothing: parseInt() without a radix is reported everywhere.",
  },
  "jsx-uses-vars": {
    title: "react/jsx-uses-vars is no longer needed",
    why: "ESLint 10 tracks JSX references itself, so the rule is not needed and no-unused-vars / no-undef results on JSX names can change.",
  },
  "removed-api": {
    title: "Removed Node API",
    why: "LegacyESLint, FlatESLint and the eslintrc mode of Linter are gone in ESLint 10.",
  },
};

const UNKNOWN: RuleInfo = { title: "ESLint 10 upgrade check", why: "" };

export function check(repo: LoadedRepo): CheckerReport {
  const files: Record<string, string> = {};
  for (const [path, text] of repo.texts) if (wantsFile(path)) files[path] = text;
  const result = staticChecks(files);
  return {
    id: "eslint10",
    name: "ESLint 10",
    about: "What stops linting, or lints differently, when a repo moves from ESLint 9 (end of life since August 6, 2026) to 10.",
    version: versions.eslint10.version,
    repoUrl: REPO_URL,
    cli: { label: "Compare real ESLint 9 and 10 runs on two local checkouts", command: "git clone https://github.com/atokim4/eslint10-parity && cd eslint10-parity && npm ci && node dist/cli.mjs compare --before ../main --after ../eslint-10-branch" },
    rulesChecked: Object.keys(RULES).length,
    findings: result.map((f): Finding => {
      const info = RULES[f.id] ?? UNKNOWN;
      return {
        rule: f.id,
        severity: SEVERITY[f.severity],
        title: info.title,
        message: f.message,
        file: f.file,
        line: f.line ?? 1,
        why: info.why || f.message,
        fix: f.fix ?? "See the migration guide section linked below.",
        sourceUrl: f.docs,
      };
    }),
    notes: ["Reads files only. Whether lint results change can only be seen by running both versions; the CLI does that."],
  };
}
