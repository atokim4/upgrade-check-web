import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULES, check } from "../src/checkers/eslint10.ts";
import { tierOf } from "../src/lib/select.ts";
import { repoOf } from "./helpers/repo.ts";

describe("ESLint 10 checker", () => {
  it("reports an eslintrc-only repo that bumps eslint to 10 (descope/node-sdk shape)", () => {
    const report = check(
      repoOf({
        ".eslintrc.js": "module.exports = { extends: ['airbnb-base'] };\n",
        "package.json": '{"scripts":{"lint":"eslint lib/**/*.ts --fix"},"devDependencies":{"eslint":"^10.14.0"}}',
      }),
    );
    expect(report.findings.find((f) => f.rule === "eslintrc-only")).toMatchObject({ severity: "error", file: ".eslintrc.js", title: RULES["eslintrc-only"]!.title });
  });

  it("names undeclared packages ESLint 10 stops installing (aggre/ullr shape)", () => {
    const report = check(
      repoOf({
        "eslint.config.mjs": "import eslint from '@eslint/js'\nimport globals from 'globals'\n",
        "package.json": '{"devDependencies":{"eslint":"10.14.0"}}',
      }),
    );
    expect(report.findings.filter((f) => f.rule === "undeclared-eslint-package").map((f) => f.line)).toEqual([1, 2]);
  });

  it("has a title for every check id the engine can emit", () => {
    const source = readFileSync(new URL("../src/engines/eslint10/static/index.ts", import.meta.url), "utf8");
    const emitted = [...new Set([...source.matchAll(/id: "([a-z0-9-]+)"/g)].map((m) => m[1] as string))];
    expect(emitted.length).toBeGreaterThan(10);
    expect(emitted.filter((id) => !(id in RULES))).toEqual([]);
  });

  it("reads ESLint config files as config", () => {
    for (const p of [".eslintrc", ".eslintrc.cjs", "apps/web/eslint.config.ts", ".eslintignore"]) expect(tierOf(p), p).toBe("config");
  });
});
