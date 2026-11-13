import { describe, expect, it } from "vitest";
import { check } from "../../src/checkers/deno.ts";
import { repoOf } from "../helpers/repo.ts";

const found = (files: Record<string, string>) => check(repoOf(files)).findings.map((f) => `${f.rule}@${f.file}:${f.line}`);

describe("deno checker", () => {
  it("finds Deploy steps, Deno KV, Deno.cron, Fresh and Val Town imports", () => {
    const report = check(
      repoOf({
        "deno.json": '{\n  "tasks": { "start": "deno run -A main.ts" },\n  "imports": { "$fresh/": "https://deno.land/x/fresh@1.7.3/" },\n  "deploy": { "project": "x" }\n}\n',
        ".github/workflows/deploy.yml": "jobs:\n  deploy:\n    steps:\n      - uses: denoland/setup-deno@v2\n      - uses: denoland/deployctl@v1\n",
        "main.ts": [
          'import { blob } from "https://esm.town/v/std/blob";',
          "const kv = await Deno.openKv();",
          'Deno.cron("sweep", "0 * * * *", sweep);',
          'const port = Number(Deno.env.get("PORT"));',
          "Deno.serve({ port }, handler);",
        ].join("\n"),
      }),
    );
    const ids = report.findings.map((f) => `${f.rule}@${f.file}:${f.line}`);
    expect(ids).toEqual([
      "deploy-hosting@.github/workflows/deploy.yml:5",
      "deno-runtime@deno.json:1",
      "fresh@deno.json:3",
      "deploy-hosting@deno.json:4",
      "val-town@main.ts:1",
      "deno-kv@main.ts:2",
      "deno-cron@main.ts:3",
    ]);
    const runtime = report.findings.find((f) => f.rule === "deno-runtime")!;
    expect(runtime.severity).toBe("note");
    expect(runtime.message).toBe("Deno project: 2 Deno.* uses (2 with a 1:1 Node rewrite) in 1 of the files read.");
    expect(report.cli?.command).toBe("npx github:atokim4/deno-exit . --fix");
  });

  it("treats a self-hosted Deno app as a note only", () => {
    const report = check(repoOf({ "deno.json": '{ "tasks": { "dev": "deno run -A main.ts" } }', "main.ts": 'import { join } from "jsr:@std/path@^1";\nconsole.log(Deno.args, join("a", "b"));\n' }));
    expect(report.findings.map((f) => [f.rule, f.severity])).toEqual([["deno-runtime", "note"]]);
    expect(report.findings[0]!.message).toMatch(/1 Deno-style imports/);
  });

  it("leaves Deno KV in test files out", () => {
    const kv = "const kv = await Deno.openKv(':memory:');\n";
    expect(found({ "deno.json": "{}", "mod_test.ts": kv, "e2e/app.ts": kv, "kv.test.ts": kv, "src/store.ts": kv }).filter((f) => f.startsWith("deno-kv"))).toEqual(["deno-kv@src/store.ts:1"]);
  });

  it("has no false positives on a Node app", () => {
    expect(
      found({
        "package.json": '{"scripts":{"start":"node server.js"}}',
        "server.js": 'import express from "express";\n// Deno.serve would be nicer\nconst denominator = 3;\nfetch("https://example.com/x.js");\n',
        "Dockerfile": "FROM node:24-slim\n",
      }),
    ).toEqual([]);
  });
});
