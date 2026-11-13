import type { LoadedRepo } from "../../src/lib/loader.ts";
import { planReads } from "../../src/lib/select.ts";

/** A repo as the GitHub loader would return it, with every file read. */
export function repoOf(files: Record<string, string>, name = "sample"): LoadedRepo {
  const tree = Object.entries(files).map(([path, text]) => ({ path, size: text.length }));
  return {
    name,
    source: { kind: "github", ref: { owner: "o", repo: name }, sha: "b".repeat(40) },
    paths: tree.map((e) => e.path),
    texts: new Map(Object.entries(files)),
    plan: planReads(tree),
    listTruncated: false,
    unreadable: [],
  };
}
