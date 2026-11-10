import type { Edit, Finding } from "./types.ts";

export interface FileFix {
  file: string;
  before: string;
  after: string;
  /** Findings whose edits were applied. */
  applied: Finding[];
  /** Fixable findings left alone because their edits overlapped another fix. */
  skipped: Finding[];
}

const overlaps = (a: Edit, b: Edit) => {
  // Two inserts at the same point are fine (ordered); an insert at the edge of a replacement is fine too.
  if (a.start === a.end || b.start === b.end) return a.start > b.start && a.start < b.end || b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
};

const same = (a: Edit, b: Edit) => a.start === b.start && a.end === b.end && a.text === b.text;

/**
 * Applies each finding's edits as a unit: all of them or none, so a command is never half rewritten. Identical
 * edits from two findings (both want `--yes` at the same spot) are applied once.
 */
export function planFixes(texts: Map<string, string>, findings: readonly Finding[]): FileFix[] {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) if (f.edits?.length) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);

  const result: FileFix[] = [];
  for (const [file, list] of byFile) {
    const before = texts.get(file);
    if (before === undefined) continue;
    const accepted: Edit[] = [];
    const applied: Finding[] = [];
    const skipped: Finding[] = [];
    for (const f of list) {
      const fresh = f.edits!.filter((e) => !accepted.some((a) => same(a, e)));
      if (fresh.some((e) => accepted.some((a) => overlaps(a, e)))) {
        skipped.push(f);
        continue;
      }
      accepted.push(...fresh);
      applied.push(f);
    }
    const after = applyEdits(before, accepted);
    if (after !== before) result.push({ file, before, after, applied, skipped });
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

export function applyEdits(text: string, edits: readonly Edit[]): string {
  // Back to front so earlier offsets stay valid. At one offset a replacement goes first, then inserts from the
  // highest `order` down, so the lowest order ends up leftmost.
  const isInsert = (e: Edit) => (e.start === e.end ? 1 : 0);
  const sorted = [...edits].sort((a, b) => b.start - a.start || isInsert(a) - isInsert(b) || (b.order ?? 0) - (a.order ?? 0));
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** A unified diff (3 lines of context) of one file. */
export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === "=") { i++; continue; }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while changes are less than 2*context lines apart.
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.kind !== "=") end = j;
      else if (j - end > context * 2) break;
    }
    end = Math.min(ops.length - 1, end + context);
    const hunk = ops.slice(start, end + 1);
    const aStart = hunk[0]!.ai + 1;
    const bStart = hunk[0]!.bi + 1;
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.kind === "=" ? " " : o.kind}${o.text}`);
    i = end + 1;
  }
  return out.join("\n");
}

interface Op {
  kind: "=" | "-" | "+";
  text: string;
  /** Index in `a` (for = and -) or the position in `a` where an insert happens. */
  ai: number;
  bi: number;
}

/** Line diff by longest common subsequence; config and CI files are small enough for O(n·m). */
function diffLines(a: string[], b: string[]): Op[] {
  // Trim the common head and tail first so the table only covers the changed middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const ops: Op[] = [];
  for (let k = 0; k < head; k++) ops.push({ kind: "=", text: a[k]!, ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) { ops.push({ kind: "=", text: am[i]!, ai: head + i, bi: head + j }); i++; j++; }
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: "-", text: am[i]!, ai: head + i, bi: head + j }); i++; }
    else { ops.push({ kind: "+", text: bm[j]!, ai: head + i, bi: head + j }); j++; }
  }
  for (let k = 0; k < tail; k++) ops.push({ kind: "=", text: a[a.length - tail + k]!, ai: a.length - tail + k, bi: b.length - tail + k });
  return ops;
}
