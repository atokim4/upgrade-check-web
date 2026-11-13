import { describe, expect, it } from "vitest";
import { GITHUB_LIMITS, planReads, tierOf, type TreeEntry } from "../src/lib/select.ts";

const entry = (path: string, size = 100): TreeEntry => ({ path, size });

describe("tierOf", () => {
  it.each([
    [".github/workflows/ci.yml", "config"],
    ["Dockerfile", "config"],
    ["apps/web/Dockerfile.dev", "config"],
    [".nvmrc", "config"],
    ["supabase/config.toml", "config"],
    ["package.json", "config"],
    ["pnpm-lock.yaml", "lockfile"],
    ["supabase/migrations/20260101_init.sql", "sql"],
    ["src/server.ts", "source"],
    ["README.md", undefined],
    ["node_modules/x/package.json", undefined],
    ["dist/index.js", undefined],
  ])("%s is %s", (path, tier) => {
    expect(tierOf(path)).toBe(tier);
  });
});

describe("planReads", () => {
  it("reads config before source and stops at the file limit", () => {
    const tree = [
      ...Array.from({ length: 120 }, (_, i) => entry(`src/components/c${i}.tsx`)),
      entry("supabase/functions/api/index.ts"),
      entry(".github/workflows/ci.yml"),
      entry("package.json"),
    ];
    const plan = planReads(tree);
    expect(plan.read.slice(0, 2).map((e) => e.path)).toEqual([".github/workflows/ci.yml", "package.json"]);
    expect(plan.read[2]!.path).toBe("supabase/functions/api/index.ts");
    expect(plan.read).toHaveLength(GITHUB_LIMITS.files);
    expect(plan.skipped.source).toBe(123 - GITHUB_LIMITS.files);
  });

  it("marks the SQL as incomplete when there are more migrations than the limit", () => {
    const many = Array.from({ length: GITHUB_LIMITS.sql + 1 }, (_, i) => entry(`supabase/migrations/${String(i).padStart(3, "0")}.sql`));
    expect(planReads(many).sqlComplete).toBe(false);
    expect(planReads(many.slice(1)).sqlComplete).toBe(true);
  });

  it("skips oversized files and counts them", () => {
    const plan = planReads([entry("src/huge.js", 5 * 1024 * 1024), entry("package-lock.json", 5 * 1024 * 1024)]);
    expect(plan.read.map((e) => e.path)).toEqual(["package-lock.json"]);
    expect(plan.skipped.source).toBe(1);
  });
});
