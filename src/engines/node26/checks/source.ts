// JavaScript / TypeScript uses of APIs that the Node.js deprecations page lists as End-of-Life in 25 or 26
// (plus three runtime deprecations as notes). Pattern-based on purpose: no type information, so each pattern is
// narrow and anchored on the module it comes from.
import type { Model } from "../contexts.ts";
import type { NodeRuntime } from "../node-version.ts";
import { lineOf, lineText } from "../sources.ts";
import type { Finding, Severity } from "../types.ts";

/**
 * Comments blanked (`code`), comments plus string contents blanked (`bare`), offsets and newlines kept, and the
 * string literals' spans so a match that starts inside one (code in a test fixture string) can be dropped.
 */
export function maskJs(text: string): { code: string; bare: string; strings: { start: number; end: number }[] } {
  const strings: { start: number; end: number }[] = [];
  const code = text.split("");
  const bare = text.split("");
  const blank = (arr: string[], from: number, to: number) => { for (let k = from; k < to; k++) if (arr[k] !== "\n") arr[k] = " "; };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      const e = text.indexOf("\n", i);
      const end = e === -1 ? text.length : e;
      blank(code, i, end); blank(bare, i, end);
      i = end;
    } else if (c === "/" && n === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e === -1 ? text.length : e + 2;
      blank(code, i, end); blank(bare, i, end);
      i = end;
    } else if (c === "/" && regexCanStart(text, i)) {
      // A regex literal: /…/flags, with escapes and [character classes] that may hold a slash.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n") {
        const ch = text[j]!;
        if (ch === "\\") j++;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      if (text[j] !== "/") { i++; continue; }
      blank(bare, i + 1, j);
      strings.push({ start: i, end: j });
      i = j + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (c !== "`" && text[j] === "\n") break;
        j++;
      }
      blank(bare, i + 1, j);
      strings.push({ start: i, end: j });
      i = j + 1;
    } else i++;
  }
  return { code: code.join(""), bare: bare.join(""), strings };
}

/** A `/` starts a regex literal (not a division) after an operator, an opening bracket or a keyword like `return`. */
function regexCanStart(text: string, at: number): boolean {
  let k = at - 1;
  while (k >= 0 && (text[k] === " " || text[k] === "\t")) k--;
  if (k < 0 || text[k] === "\n") return true;
  const prev = text[k]!;
  if ("(,=:[!&|?{};+-*%<>~^".includes(prev)) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, k - 10), k + 1));
  return Boolean(word && /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(word[1]!));
}

interface Hit {
  /** Where to report (the matched group, e.g. the module name). */
  at: number;
  /** Where the match starts; a match starting inside a string literal is not code. */
  start: number;
  detail?: string;
}

/** The masked file: `code` (no comments), `bare` (no comments, no string contents) and an inside-a-string test. */
interface Js {
  code: string;
  bare: string;
  inString(at: number): boolean;
}

interface SourceRule {
  id: string;
  removedIn: number;
  /** Runtime deprecations stay notes whatever the runtime. */
  note?: boolean;
  find(js: Js): Hit[];
  message(hit: Hit): string;
}

const all = (re: RegExp, text: string, group = 0): Hit[] =>
  [...text.matchAll(re)].map((m) => ({ at: m.index! + (group ? m[0].indexOf(m[group]!) : 0), start: m.index!, detail: m[group] ?? m[0] }));

/** Matches of `re` in `js.code` that are code, not text inside a string literal. */
const inCode = (js: Js, re: RegExp, group = 0): Hit[] => all(re, js.code, group).filter((h) => !js.inString(h.start));
const has = (js: Js, re: RegExp) => inCode(js, new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)).length > 0;

const FS_MODULE = String.raw`['"](?:node:)?fs['"]`;

/** Names bound to node:fs: `const fs = require('fs')`, `import * as fs from 'node:fs'`, `import fs from 'fs'`. */
function fsBindings(js: Js): string[] {
  const names = new Set<string>();
  for (const h of inCode(js, new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*${FS_MODULE}\s*\)`, "g"), 1)) names.add(h.detail!);
  for (const h of inCode(js, new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*${FS_MODULE}`, "g"), 1)) names.add(h.detail!);
  return [...names];
}

const importsModule = (js: Js, mod: string) => has(js, new RegExp(String.raw`(?:require\(\s*|from\s*|import\s*\(\s*)['"](?:node:)?${mod}['"]`));

/** Top-level argument count of the call whose `(` is at `open`. */
function argCount(code: string, open: number): number {
  let depth = 0;
  let count = 0;
  let any = false;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return any ? count + 1 : 0;
      continue;
    }
    if (depth === 1 && c === ",") count++;
    else if (depth === 1 && !/\s/.test(c)) any = true;
  }
  return any ? count + 1 : 0;
}

/** The text of the call whose `(` is at `open`, up to its matching `)`. */
function callText(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

const STREAM_CLASS: Record<string, string> = { readable: "Readable", writable: "Writable", duplex: "Duplex", transform: "Transform", passthrough: "PassThrough" };

const SOURCE_RULES: SourceRule[] = [
  {
    id: "dep0193-stream-internals",
    removedIn: 26,
    find: (js) => inCode(js, /(?:require\s*\(\s*|from\s*|import\s*\(\s*|import\s+)['"]((?:node:)?_stream_(?:wrap|readable|writable|duplex|transform|passthrough))['"]/g, 1),
    message: (h) => {
      const kind = h.detail!.replace(/^(?:node:)?_stream_/, "");
      const cls = STREAM_CLASS[kind];
      return cls
        ? `'${h.detail}' was removed in Node 26 (DEP0193), so require/import fails with MODULE_NOT_FOUND. Use \`require('node:stream').${cls}\` or \`import { ${cls} } from 'node:stream'\`.`
        : `'${h.detail}' was removed in Node 26 (DEP0125, DEP0193) and has no public replacement; wrap the socket with a node:stream Duplex instead.`;
    },
  },
  {
    id: "dep0063-writeheader",
    removedIn: 26,
    find: (js) => {
      const http = importsModule(js, "https?") || importsModule(js, "http2") || importsModule(js, "express");
      return all(/\b(\w+)\s*\.\s*writeHeader\s*\(/g, js.bare).filter((h) => http || /^(?:res|response|resp|reply|serverResponse)\s*\./.test(h.detail!));
    },
    message: () => "ServerResponse.writeHeader() was removed in Node 26 (DEP0063) and throws `writeHeader is not a function`. Call `writeHead()` with the same arguments.",
  },
  {
    id: "dep0030-slowbuffer",
    removedIn: 25,
    find: (js) => all(/(?<![.\w$])SlowBuffer\b/g, js.bare),
    message: () => "SlowBuffer was removed in Node 25 (DEP0030). Use `Buffer.allocUnsafeSlow(size)` (codemod: `npx codemod@latest @nodejs/slow-buffer-to-buffer-alloc-unsafe-slow`).",
  },
  {
    id: "dep0176-fs-access-constants",
    removedIn: 25,
    find: (js) => {
      const hits: Hit[] = [];
      for (const name of fsBindings(js)) hits.push(...all(new RegExp(String.raw`(?<![.\w$])${name}\.([FRWX]_OK)\b`, "g"), js.bare));
      hits.push(...inCode(js, new RegExp(String.raw`\{[^}]*\b[FRWX]_OK\b[^}]*\}\s*=\s*require\(\s*${FS_MODULE}\s*\)`, "g")));
      hits.push(...inCode(js, new RegExp(String.raw`import\s*\{[^}]*\b[FRWX]_OK\b[^}]*\}\s*from\s*${FS_MODULE}`, "g")));
      return hits;
    },
    message: (h) => `${/^[\w$]+\.[FRWX]_OK$/.test(h.detail ?? "") ? `\`${h.detail}\`` : "F_OK / R_OK / W_OK / X_OK on node:fs"} was removed in Node 25 (DEP0176) and is undefined now. Use \`fs.constants.*_OK\` (codemod: \`npx codemod@latest @nodejs/fs-access-mode-constants\`).`,
  },
  {
    id: "dep0147-rmdir-recursive",
    removedIn: 25,
    find: (js) => inCode(js, /\brmdir(?:Sync)?\s*\(/g).filter((h) => /\brecursive\s*:\s*true/.test(callText(js.code, js.code.indexOf("(", h.at)))),
    message: () => "fs.rmdir(path, { recursive: true }) throws ERR_INVALID_ARG_VALUE since Node 25 (DEP0147). Use `fs.rm(path, { recursive: true, force: true })` (codemod: `npx codemod@latest @nodejs/rmdir`).",
  },
  {
    id: "dep0173-calltracker",
    removedIn: 25,
    find: (js) => all(/\bCallTracker\b/g, js.bare),
    message: () => "assert.CallTracker was removed in Node 25 (DEP0173) and is undefined now. Use `mock.fn()` from node:test and `fn.mock.callCount()`.",
  },
  {
    id: "dep0094-assert-fail-args",
    removedIn: 25,
    find: (js) => all(/\bassert\s*\.\s*fail\s*\(/g, js.bare).filter((h) => argCount(js.bare, js.bare.indexOf("(", h.at)) > 1),
    message: () => "assert.fail() with more than one argument reached End-of-Life in Node 25 (DEP0094): the extra arguments are dropped and the first becomes the message. Pass a single message, or use `assert.strictEqual(actual, expected, message)`.",
  },
  {
    id: "dep0160-multiple-resolves",
    removedIn: 25,
    find: (js) => inCode(js, /\bprocess\s*\.\s*(?:on|once|addListener|prependListener)\s*\(\s*['"]multipleResolves['"]/g),
    message: () => "The 'multipleResolves' event was removed in Node 25 (DEP0160): this handler never runs. Remove it.",
  },
  {
    id: "dep0185-repl-without-new",
    removedIn: 25,
    find: (js) => all(/(?<!\bnew\s+)(?<![\w$])repl\s*\.\s*(?:REPLServer|Recoverable)\s*\(/g, js.bare),
    message: () => "node:repl classes must be called with `new` since Node 25 (DEP0185). Write `new repl.REPLServer(…)` or use `repl.start()` (codemod: `npx codemod@latest @nodejs/repl-classes-with-new`).",
  },
  {
    id: "dep0077-module-debug",
    removedIn: 25,
    find: (js) => all(/\bModule\s*\.\s*_debug\b/g, js.bare),
    message: () => "Module._debug() was removed in Node 25 (DEP0077). Remove the call; NODE_DEBUG=module traces module loading.",
  },
  {
    id: "dep0154-rsa-pss-hash",
    removedIn: 25,
    find: (js) => inCode(js, /\bgenerateKeyPair(?:Sync)?\s*\(\s*['"]rsa-pss['"]/g).filter((h) => /[{,]\s*(?:hash|mgf1Hash)\s*:/.test(callText(js.bare, js.bare.indexOf("(", h.at)))),
    message: () => "generateKeyPair('rsa-pss') throws ERR_INVALID_ARG_VALUE for `hash` / `mgf1Hash` since Node 25 (DEP0154). Rename them to `hashAlgorithm` / `mgf1HashAlgorithm` (codemod: `npx codemod@latest @nodejs/crypto-rsa-pss-update`).",
  },
  {
    id: "dep0132-worker-terminate-callback",
    removedIn: 25,
    find: (js) => (importsModule(js, "worker_threads") ? all(/\.\s*terminate\s*\(/g, js.bare).filter((h) => argCount(js.bare, js.bare.indexOf("(", h.at)) > 0) : []),
    message: () => "worker.terminate(callback) reached End-of-Life in Node 25 (DEP0132): the callback is never called. Use `await worker.terminate()` or the worker's 'exit' event.",
  },
  {
    id: "dep0182-gcm-auth-tag",
    removedIn: 26,
    note: true,
    find: (js) => {
      if (!/\bsetAuthTag\s*\(/.test(js.bare) || /\bauthTagLength\b/.test(js.bare)) return [];
      return inCode(js, /\bcreateDecipheriv\s*\(\s*['"`][^'"`]*gcm[^'"`]*['"`]/gi);
    },
    message: () => "AES-GCM decryption without authTagLength: since Node 26 (DEP0182) setAuthTag() rejects tags shorter than 16 bytes. If yours are shorter, pass `{ authTagLength }` to createDecipheriv().",
  },
  {
    id: "dep0205-module-register",
    removedIn: 26,
    note: true,
    find: (js) => {
      if (!importsModule(js, "module")) return [];
      const named = has(js, /import\s*\{[^}]*\bregister\b[^}]*\}\s*from\s*['"](?:node:)?module['"]/)
        || has(js, /\{[^}]*\bregister\b[^}]*\}\s*=\s*require\(\s*['"](?:node:)?module['"]\s*\)/);
      const hits = all(/(?<![\w$])module\s*\.\s*register\s*\(/g, js.bare);
      if (named) hits.push(...all(/(?<![.\w$])register\s*\(/g, js.bare));
      return hits;
    },
    message: () => "module.register() prints a runtime deprecation warning on Node 26 (DEP0205) and will be removed. Move the hooks to `module.registerHooks()`.",
  },
  {
    id: "dep0198-shake-output-length",
    removedIn: 25,
    note: true,
    find: (js) => inCode(js, /\bcreateHash\s*\(\s*['"]shake(?:128|256)['"]\s*\)/gi),
    message: () => "SHAKE-128/256 without options.outputLength prints a deprecation warning since Node 25 (DEP0198). Pass `{ outputLength }`.",
  },
  {
    id: "dep0031-ecdh-setpublickey",
    removedIn: 25,
    note: true,
    find: (js) => (/\bcreateECDH\s*\(/.test(js.bare) ? all(/\.\s*setPublicKey\s*\(/g, js.bare) : []),
    message: () => "ecdh.setPublicKey() prints a deprecation warning since Node 25 (DEP0031). Drop it; the public key comes from the private key.",
  },
];

/** Error when the code can run on the removal major (or the runtime can't be told); a warning when every pin is older. */
function apiSeverity(runtimes: NodeRuntime[], removedIn: number): Severity {
  if (runtimes.length === 0) return "error";
  return runtimes.some((r) => r.major === undefined || r.floating || r.major >= removedIn) ? "error" : "warning";
}

export function checkSourceApis(model: Model): Finding[] {
  const runtimes = model.versions.map((v) => v.runtime);
  const out: Finding[] = [];
  for (const file of model.files.filter((f) => f.kind === "source")) {
    const pin = model.pinFor(file.path);
    const known = pin.major !== undefined ? [...runtimes, pin] : runtimes;
    // Cheap pre-filter: most files mention none of these names.
    if (!/_stream_|writeHeader|SlowBuffer|_OK\b|rmdir|CallTracker|assert|multipleResolves|repl|_debug|rsa-pss|terminate|setAuthTag|register|shake|setPublicKey/.test(file.text)) continue;
    const { code, bare, strings } = maskJs(file.text);
    const inString = (at: number) => {
      // Binary search: the string literals are in file order and don't overlap.
      let lo = 0;
      let hi = strings.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = strings[mid]!;
        if (at <= s.start) hi = mid - 1;
        else if (at >= s.end) lo = mid + 1;
        else return true;
      }
      return false;
    };
    const js: Js = { code, bare, inString };
    for (const rule of SOURCE_RULES) {
      const seen = new Set<number>();
      for (const hit of rule.find(js)) {
        const line = lineOf(file.text, hit.at);
        if (seen.has(line)) continue;
        seen.add(line);
        out.push({
          rule: rule.id,
          severity: rule.note ? "note" : apiSeverity(known, rule.removedIn),
          message: rule.message(hit),
          file: file.path,
          line,
          snippet: lineText(file.text, line).trim(),
        });
      }
    }
  }
  return out;
}
