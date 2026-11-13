import { describe, expect, it } from "vitest";
import { check } from "../../src/checkers/prisma.ts";
import { repoOf } from "../helpers/repo.ts";

const rules = (files: Record<string, string>) => check(repoOf(files)).findings.map((f) => `${f.rule}@${f.file}:${f.line}`);

describe("prisma checker", () => {
  it("finds the extension, its $extends call, cacheStrategy and $accelerate.invalidate in source", () => {
    const report = check(
      repoOf({
        "package.json": JSON.stringify({ dependencies: { "@prisma/client": "^6.19.0", "@prisma/extension-accelerate": "^2.0.2" } }, null, 2),
        "src/db.ts": [
          'import { PrismaClient } from "@prisma/client";',
          'import { withAccelerate } from "@prisma/extension-accelerate";',
          "",
          "export const prisma = new PrismaClient().$extends(withAccelerate());",
        ].join("\n"),
        "src/posts.ts": [
          'import { prisma } from "./db";',
          "export const list = () =>",
          "  prisma.post.findMany({ where: { published: true }, cacheStrategy: { ttl: 60 } });",
          "export async function bust() {",
          '  await prisma.$accelerate.invalidate({ tags: ["posts"] });',
          "}",
        ].join("\n"),
      }),
    );
    expect(report.findings.map((f) => `${f.rule}@${f.file}:${f.line}`)).toEqual([
      "dependency@package.json:4",
      "extension-import@src/db.ts:2",
      "extends-call@src/db.ts:4",
      "cache-strategy@src/posts.ts:3",
      "cache-invalidate@src/posts.ts:5",
    ]);
    expect(report.findings.every((f) => f.severity === "error")).toBe(true);
    expect(report.findings.find((f) => f.rule === "extends-call")?.approx).toBe(true);
    expect(report.findings.find((f) => f.rule === "dependency")?.approx).toBeUndefined();
    expect(report.cli?.command).toBe("npx github:atokim4/prisma-accelerate-exit . --fix");
  });

  it("finds generate flags in scripts and CI, Accelerate URLs in env examples, and the edge client", () => {
    expect(
      rules({
        "package.json": JSON.stringify({ scripts: { build: "prisma generate --no-engine && next build" }, dependencies: { "@prisma/client": "^6.19.0" } }, null, 2),
        ".github/workflows/deploy.yml": "jobs:\n  d:\n    steps:\n      - run: npx prisma generate --accelerate\n",
        ".env.example": 'DATABASE_URL="prisma://accelerate.prisma-data.net/?api_key=abc"\n',
        "src/edge.ts": 'import { PrismaClient } from "@prisma/client/edge";\n',
      }),
    ).toEqual(["accelerate-url@.env.example:1", "generate-flag@.github/workflows/deploy.yml:4", "generate-flag@package.json:3", "edge-client-import@src/edge.ts:1"]);
  });

  it("redacts the API key from an Accelerate URL", () => {
    const f = check(repoOf({ ".env.example": 'DATABASE_URL="prisma://accelerate.prisma-data.net/?api_key=secret123"\n' })).findings[0]!;
    expect(f.message).not.toContain("secret123");
    expect(f.snippet).not.toContain("secret123");
  });

  it("flags engineType = client only without a driver adapter", () => {
    const schema = 'generator client {\n  provider   = "prisma-client-js"\n  engineType = "client"\n}\n';
    expect(rules({ "prisma/schema.prisma": schema })).toEqual(["engine-type-client@prisma/schema.prisma:3"]);
    expect(rules({ "prisma/schema.prisma": schema, "package.json": '{"dependencies":{"@prisma/adapter-pg":"^6.19.0"}}' })).toEqual([]);
  });

  it("has no false positives on a plain Prisma app, local prisma dev URLs and comments", () => {
    expect(
      rules({
        "package.json": JSON.stringify({ dependencies: { "@prisma/client": "^6.19.0" }, scripts: { build: "prisma generate && tsc" } }, null, 2),
        ".env.example": 'DATABASE_URL="prisma+postgres://localhost:51213/?api_key=dev"\n',
        "src/db.ts": [
          'import { PrismaClient } from "@prisma/client";',
          "// we used to call .$extends(withAccelerate()) here",
          "/* cacheStrategy: { ttl: 60 } was removed */",
          "export const prisma = new PrismaClient();",
          "const options = { cacheStrategy: 1 };",
        ].join("\n"),
      }),
    ).toEqual(["cache-strategy@src/db.ts:5"]);
  });

  it("ignores Prisma-like names in a repo that doesn't use Prisma", () => {
    expect(rules({ "package.json": '{"dependencies":{"lru-cache":"^11.0.0"}}', "src/cache.ts": "const cfg = { cacheStrategy: 'lru' }; // like prisma's\n" })).toEqual([]);
  });
});
