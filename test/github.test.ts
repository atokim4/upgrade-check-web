import { describe, expect, it } from "vitest";
import { GitHub, GitHubError, type RateLimit } from "../src/lib/github.ts";

const SHA = "a".repeat(40);
const rateHeaders = (remaining: number) => ({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": "1794288950" });

function fakeFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("no route", { status: 500 });
    return hit[1]();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const ref = { owner: "o", repo: "r" };

describe("GitHub", () => {
  it("resolves HEAD, lists the tree and reads raw files", async () => {
    const seen: RateLimit[] = [];
    const { fetch, calls } = fakeFetch({
      "/commits/HEAD": () => new Response(SHA, { headers: rateHeaders(59) }),
      [`/git/trees/${SHA}`]: () =>
        Response.json({ tree: [{ path: "a b/c.yml", type: "blob", size: 3 }, { path: "a b", type: "tree" }], truncated: false }, { headers: rateHeaders(58) }),
      "raw.githubusercontent.com": () => new Response("hello"),
    });
    const gh = new GitHub(fetch, (r) => seen.push(r));
    expect(await gh.resolve(ref)).toBe(SHA);
    const tree = await gh.tree(ref, SHA);
    expect(tree.entries).toEqual([{ path: "a b/c.yml", size: 3 }]);
    expect(await gh.raw(ref, SHA, "a b/c.yml")).toBe("hello");
    expect(calls.at(-1)).toBe(`https://raw.githubusercontent.com/o/r/${SHA}/a%20b/c.yml`);
    expect(seen.map((r) => r.remaining)).toEqual([59, 58]);
    expect(gh.rate?.resetAt.toISOString()).toBe("2026-11-10T05:35:50.000Z");
  });

  it("says not found (or private) on 404", async () => {
    const { fetch } = fakeFetch({ "/commits/": () => new Response("{}", { status: 404, headers: rateHeaders(57) }) });
    await expect(new GitHub(fetch).resolve({ ...ref, ref: "nope" })).rejects.toMatchObject({ kind: "not-found" });
  });

  it("reports the rate limit with its reset time", async () => {
    const { fetch } = fakeFetch({ "/commits/": () => new Response("{}", { status: 403, headers: rateHeaders(0) }) });
    const err = (await new GitHub(fetch).resolve(ref).catch((e) => e)) as GitHubError;
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe("rate-limited");
    expect(err.rate?.remaining).toBe(0);
  });

  it("tells an empty repository apart", async () => {
    const { fetch } = fakeFetch({ "/commits/": () => new Response("{}", { status: 409 }) });
    await expect(new GitHub(fetch).resolve(ref)).rejects.toMatchObject({ kind: "empty" });
  });

  it("turns a network failure into a readable error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(new GitHub(fetchImpl).resolve(ref)).rejects.toMatchObject({ kind: "network" });
  });
});
