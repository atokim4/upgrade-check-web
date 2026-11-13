import { unifiedDiff } from "../engines/node26/fix.ts";
import type { LoadedRepo } from "../lib/loader.ts";

interface EngineFinding {
  file: string;
  edits?: { start: number; end: number; text: string; order?: number }[];
}

type Plan<F> = (texts: Map<string, string>, findings: F[]) => { file: string; before: string; after: string }[];

/** The engine's safe fixes for these findings as one unified diff, or undefined when there are none. */
export function diffOf<F extends EngineFinding>(texts: Map<string, string>, plan: Plan<F>, findings: F[]): string | undefined {
  const fixes = plan(texts, findings);
  return fixes.length ? fixes.map((f) => unifiedDiff(f.file, f.before, f.after)).join("\n") + "\n" : undefined;
}

/** The loaded files an engine classifies, with its kind, sorted by path. */
export function filesOf<K extends string>(repo: LoadedRepo, kindOf: (path: string) => K | undefined) {
  const files: { path: string; text: string; kind: K }[] = [];
  for (const [path, text] of repo.texts) {
    const kind = kindOf(path);
    if (kind) files.push({ path, text, kind });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
