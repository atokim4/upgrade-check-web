import { GitHub, GitHubError } from "./github.ts";
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
  /** Files in the read plan that couldn't be downloaded, even after a retry. */
  unreadable: string[];
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

/** Above this share of failed downloads the scan stops: the report would say too little to be trusted. */
const MAX_UNREADABLE = 0.2;

export async function loadFromGitHub(ref: RepoRef, gh: GitHub, progress: Progress, signal?: AbortSignal): Promise<LoadedRepo> {
  const sha = await gh.resolve(ref);
  const tree = await gh.tree(ref, sha);
  const plan = planReads(tree.entries);
  const texts = new Map<string, string>();
  const unreadable: string[] = [];
  const fetchOne = (path: string) => gh.raw(ref, sha, path, signal);
  await readAll(plan.read, async (e) => {
    // raw.githubusercontent.com sometimes answers one file with a 5xx: retry once, then leave that file out.
    try {
      texts.set(e.path, await fetchOne(e.path));
    } catch (first) {
      if (!(first instanceof GitHubError) || signal?.aborted) throw first;
      try {
        texts.set(e.path, await fetchOne(e.path));
      } catch (err) {
        if (!(err instanceof GitHubError)) throw err;
        unreadable.push(e.path);
      }
    }
  }, progress);
  if (unreadable.length > Math.max(1, plan.read.length * MAX_UNREADABLE)) {
    throw new GitHubError("network", `${unreadable.length} of ${plan.read.length} files couldn't be downloaded from raw.githubusercontent.com.`);
  }
  return { name: ref.repo, source: { kind: "github", ref, sha }, paths: tree.entries.map((e) => e.path), texts, plan, listTruncated: tree.truncated, unreadable: unreadable.sort() };
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
  return { name, source: { kind: "local" }, paths: entries.map((e) => e.path).sort(), texts, plan, listTruncated: truncated, unreadable: [] };
}
