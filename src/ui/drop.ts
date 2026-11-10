import type { LocalFile } from "../lib/loader.ts";
import { inSkippedDir, SKIP_DIRS } from "../lib/select.ts";

/** Paths kept from a dropped or picked folder (after node_modules, .git, build output are left out). */
export const MAX_LOCAL_FILES = 20000;

export interface Dropped {
  name: string;
  files: LocalFile[];
  truncated: boolean;
}

/** Files from a folder picker, without dependency and build folders. */
export function pickedFiles(list: readonly File[]): Dropped | undefined {
  const all = list.map((file) => ({ path: file.webkitRelativePath || file.name, file })).filter((f) => !inSkippedDir(f.path));
  if (!all.length) return undefined;
  return { name: all[0]!.path.split("/")[0] ?? "folder", files: all.slice(0, MAX_LOCAL_FILES), truncated: all.length > MAX_LOCAL_FILES };
}

const readEntries = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** Walks a dropped folder (or files), skipping dependency and build folders. */
export async function collectDropped(data: DataTransfer): Promise<Dropped | undefined> {
  const roots = [...data.items].map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
  if (!roots.length) return undefined;
  const files: LocalFile[] = [];
  let truncated = false;
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (files.length >= MAX_LOCAL_FILES) {
      truncated = true;
      return;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      files.push({ path, file: await fileOf(entry as FileSystemFileEntry) });
      return;
    }
    if (!entry.isDirectory || SKIP_DIRS.has(entry.name)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most 100 entries per call; keep reading until it returns none.
    for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
      for (const child of batch) await walk(child, path);
    }
  };
  for (const root of roots) await walk(root, "");
  const single = roots.length === 1 && roots[0]!.isDirectory;
  return { name: single ? roots[0]!.name : "dropped files", files, truncated };
}
