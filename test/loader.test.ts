import { describe, expect, it } from "vitest";
import { GitHub } from "../src/lib/github.ts";
import { loadFromGitHub } from "../src/lib/loader.ts";

const SHA = "c".repeat(40);
const ref = { owner: "o", repo: "r" };

/** A repo with `files` (path → text); raw reads of a path answer `failures[path]` errors first, then the text. */
function fakeGitHub(files: Record<string, string>, failures: Record<string, number> = {}) {
  const calls: string[] = [];
  const left = { ...failures };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/commits/")) return new Response(SHA);
    if (url.includes("/git/trees/")) return Response.json({ tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", size: text.length })) });
    const path = decodeURIComponent(url.split(`/${SHA}/`)[1] ?? "");
    if ((left[path] ?? 0) > 0) {
      left[path]!--;
      return new Response("busy", { status: 501 });
    }
    return new Response(files[path] ?? "", { status: path in files ? 200 : 404 });
  }) as typeof fetch;
  return { gh: new GitHub(fetchImpl), calls };
}

describe("loadFromGitHub", () => {
  const files = { "package.json": '{"name":"x"}', "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "src/c.ts": "x\n", "src/d.ts": "y\n", "src/empty.ts": "" };

  it("uses 2 API calls, skips empty files and retries a failed raw read once", async () => {
    const { gh, calls } = fakeGitHub(files, { "src/a.ts": 1 });
    const repo = await loadFromGitHub(ref, gh, () => {});
    expect(calls.filter((u) => u.includes("api.github.com"))).toHaveLength(2);
    expect(repo.texts.get("src/a.ts")).toBe("export const a = 1;\n");
    expect(repo.texts.has("src/empty.ts")).toBe(false);
    expect(repo.unreadable).toEqual([]);
  });

  it("leaves out a file that keeps failing and reports it", async () => {
    const { gh } = fakeGitHub(files, { "src/b.ts": 5 });
    const repo = await loadFromGitHub(ref, gh, () => {});
    expect(repo.unreadable).toEqual(["src/b.ts"]);
    expect(repo.texts.size).toBe(4);
  });

  it("stops when too many files fail", async () => {
    const { gh } = fakeGitHub(files, { "src/a.ts": 5, "src/b.ts": 5, "src/c.ts": 5 });
    await expect(loadFromGitHub(ref, gh, () => {})).rejects.toThrow(/3 of 5 files couldn't be downloaded/);
  });
});
