import { describe, expect, it } from "vitest";
import { InputError, parseRepoInput, repoLabel } from "../src/lib/repo-input.ts";

describe("parseRepoInput", () => {
  it.each([
    ["vercel/next.js", { owner: "vercel", repo: "next.js" }],
    ["  https://github.com/vercel/next.js  ", { owner: "vercel", repo: "next.js" }],
    ["github.com/vercel/next.js/", { owner: "vercel", repo: "next.js" }],
    ["https://www.github.com/vercel/next.js.git", { owner: "vercel", repo: "next.js" }],
    ["git@github.com:vercel/next.js.git", { owner: "vercel", repo: "next.js" }],
    ["vercel/next.js@canary", { owner: "vercel", repo: "next.js", ref: "canary" }],
    ["vercel/next.js@release/v15", { owner: "vercel", repo: "next.js", ref: "release/v15" }],
    ["https://github.com/vercel/next.js/tree/v15.0.0", { owner: "vercel", repo: "next.js", ref: "v15.0.0" }],
    ["https://github.com/a/b/blob/main/src/x.ts#L3", { owner: "a", repo: "b", ref: "main" }],
    ["https://github.com/a/b/commit/6d5e7ba14d", { owner: "a", repo: "b", ref: "6d5e7ba14d" }],
    ["https://github.com/a/b?tab=readme", { owner: "a", repo: "b" }],
  ])("reads %s", (input, expected) => {
    expect(parseRepoInput(input)).toEqual({ ref: undefined, ...expected });
  });

  it.each([
    [""],
    ["vercel"],
    ["https://gitlab.com/a/b"],
    ["a/.."],
    ["-bad/name"],
    ["a/b@has space"],
  ])("rejects %j with a message", (input) => {
    expect(() => parseRepoInput(input)).toThrow(InputError);
  });

  it("labels a ref", () => {
    expect(repoLabel({ owner: "a", repo: "b", ref: "v1" })).toBe("a/b@v1");
    expect(repoLabel({ owner: "a", repo: "b" })).toBe("a/b");
  });
});
