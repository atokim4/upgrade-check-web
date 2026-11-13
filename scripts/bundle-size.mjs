#!/usr/bin/env node
// Fails when the built JavaScript (every chunk together, gzipped) goes over the budget.
// Usage: node scripts/bundle-size.mjs [<budget in KB, default 250>]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = join(import.meta.dirname, "..", "dist", "assets");
const budget = Number(process.argv[2] ?? 250) * 1024;
const chunks = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => ({ f, gz: gzipSync(readFileSync(join(dir, f))).length }));
const total = chunks.reduce((n, c) => n + c.gz, 0);
const entry = chunks.find((c) => c.f.startsWith("main-"));
console.log(`JS: ${chunks.length} chunks, ${(total / 1024).toFixed(1)} KB gzip in total, entry ${entry ? (entry.gz / 1024).toFixed(1) : "?"} KB (budget ${budget / 1024} KB)`);
if (total > budget) {
  console.error("Over budget:", chunks.sort((a, b) => b.gz - a.gz).slice(0, 5).map((c) => `${c.f} ${(c.gz / 1024).toFixed(1)} KB`).join(", "));
  process.exit(1);
}
