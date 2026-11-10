import { GitHub } from "./github.ts";
import type { RepoRef } from "./repo-input.ts";
import { LOCAL_LIMITS, planReads, type ReadPlan, type TreeEntry } from "./select.ts";

/** What the checkers run on: every path in the repo, and the text of the files that were read. */
export interface LoadedRepo {
  name: string;
  source: { kind: "github"; ref: RepoRef; sha: string } | { kind: "local" };
  paths: string[];
  texts: Map<string, string>;
  plan: ReadPlan;
  /** The file list itself was cut short (GitHub's tree limit, or a dropped folder that was too big). */
  listTruncated: boolean;
}

export type Progress = (done: number, total: number) => void;

const CONCURRENCY = 6;

async function readAll<T>(items: readonly T[], read: (item: T) => Promise<void>, progress: Progress): Promise<void> {
  let next = 0;
  let done = 0;
  progress(0, items.length);
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await read(item);
      progress(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

export async function loadFromGitHub(ref: RepoRef, gh: GitHub, progress: Progress, signal?: AbortSignal): Promise<LoadedRepo> {
  const sha = await gh.resolve(ref);
  const tree = await gh.tree(ref, sha);
  const plan = planReads(tree.entries);
  const texts = new Map<string, string>();
  await readAll(plan.read, async (e) => {
    texts.set(e.path, await gh.raw(ref, sha, e.path, signal));
  }, progress);
  return { name: ref.repo, source: { kind: "github", ref, sha }, paths: tree.entries.map((e) => e.path), texts, plan, listTruncated: tree.truncated };
}

/** A file from a folder picker or a drop, with its path inside the chosen folder. */
export interface LocalFile {
  path: string;
  file: File;
}

/** Paths from `<input webkitdirectory>` start with the folder's own name; drop it so paths match the repo. */
export function stripTopFolder(files: readonly LocalFile[]): LocalFile[] {
  const tops = new Set(files.map((f) => f.path.split("/")[0]));
  if (tops.size !== 1 || files.some((f) => !f.path.includes("/"))) return [...files];
  return files.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf("/") + 1) }));
}

export async function loadFromFiles(name: string, all: readonly LocalFile[], progress: Progress, truncated = false): Promise<LoadedRepo> {
  const files = stripTopFolder(all);
  const byPath = new Map(files.map((f) => [f.path, f.file]));
  const entries: TreeEntry[] = files.map((f) => ({ path: f.path, size: f.file.size }));
  const plan = planReads(entries, LOCAL_LIMITS);
  const texts = new Map<string, string>();
  await readAll(plan.read, async (e) => {
    texts.set(e.path, await byPath.get(e.path)!.text());
  }, progress);
  return { name, source: { kind: "local" }, paths: entries.map((e) => e.path).sort(), texts, plan, listTruncated: truncated };
}
