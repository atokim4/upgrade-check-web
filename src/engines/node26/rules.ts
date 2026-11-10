import type { RuleMeta } from "./types.ts";

// Every rule cites the official page it is based on. Anchors on the deprecations page were taken from its own
// table of contents (Node.js v26.13.0 docs), and examples/check-sources.mjs re-checks that each one still exists.
const REL25 = "https://nodejs.org/en/blog/release/v25.0.0";
const REL26 = "https://nodejs.org/en/blog/release/v26.0.0";
const DEPS = "https://nodejs.org/api/deprecations.html";
const COREPACK_COMMIT = "https://github.com/nodejs/node/commit/f31c88021b5b815bf776066c8eca510696b8c744";
const YARN_IMAGE = "https://github.com/nodejs/docker-node#yarn-v1-classic-bundling";
const DOCKER_LTS = "https://github.com/nodejs/docker-node#nodelts";
const SETUP_NODE_CACHE = "https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#caching-packages-data";
const SETUP_NODE_V5 = "https://github.com/actions/setup-node#breaking-changes-in-v5";
const DIST = "https://nodejs.org/dist/index.json";
const NPM_ENGINES = "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#engines";
const TS_DOCS = "https://nodejs.org/api/typescript.html#modules-typescript";

/** The corepack release `--fix` installs: the newest on npm on 2026-11-10, engines ^22.22.2 || ^24.15.0 || >=26.0.0. */
export const COREPACK_PIN = "0.36.0";
/** Yarn 1 as docker-node suggests it (`npm install --global yarn@1`), pinned to its last release. */
export const YARN1_PIN = "1.22.22";

export const RULES: readonly RuleMeta[] = [
  {
    id: "corepack-not-bundled",
    severity: "error",
    title: "`corepack` runs on Node 25+, which no longer ships it",
    why: "Node.js 25.0.0 stopped distributing Corepack (nodejs/node f31c88021b, TSC vote nodejs/TSC#1697), so `corepack enable` fails with `corepack: not found` on node:lts, node:26, lts/* and setup-node 26.",
    fix: `Install it from npm first: \`npm install -g corepack@${COREPACK_PIN} && corepack enable\`, or install the package manager itself (pnpm/action-setup, \`npm install -g pnpm@<version>\`).`,
    source: COREPACK_COMMIT,
    fixable: true,
  },
  {
    id: "yarn-not-in-node26-image",
    severity: "error",
    title: "`yarn` runs in a node:26 image, which no longer bundles Yarn 1",
    why: "docker-node: Yarn v1 is not bundled into node images as of Node.js 26.0.0, so node:lts, node:26 and node:lts-alpine have no `yarn` until you install it.",
    fix: `Install Yarn 1 first (\`npm install -g yarn@${YARN1_PIN}\`), or for Yarn 2+ install corepack and run \`corepack enable\`.`,
    source: YARN_IMAGE,
    fixable: true,
  },
  {
    id: "package-manager-not-installed",
    severity: "warning",
    title: "`packageManager` names pnpm or Yarn, but nothing installs it before it runs",
    why: "Without Corepack, nothing reads the `packageManager` field on Node 25+: official node images only ship npm, so `pnpm` is not on PATH, and a global Yarn 1 refuses to run a project whose packageManager is Yarn 2+.",
    fix: "Install the exact version from `packageManager` before the first use (`npm install -g pnpm@<version>`, or pnpm/action-setup in GitHub Actions).",
    source: COREPACK_COMMIT,
    fixable: true,
  },
  {
    id: "setup-node-cache-before-pm",
    severity: "error",
    title: "setup-node caches pnpm/Yarn before that package manager is installed",
    why: "setup-node asks the package manager for its store path while it restores the cache, so `cache: pnpm` fails with `Unable to locate executable file: pnpm` unless pnpm is installed in an earlier step (setup-node docs put pnpm/action-setup first).",
    fix: "Move pnpm/action-setup (or `npm install -g pnpm@<version>`) above actions/setup-node, or drop the `cache` input.",
    source: SETUP_NODE_CACHE,
    fixable: false,
  },
  {
    id: "setup-node-v5-auto-cache",
    severity: "warning",
    title: "setup-node v5 turns on caching by itself for the `packageManager` in package.json",
    why: "setup-node v5 enabled caching by default with package manager detection; with `packageManager: pnpm@…` and no pnpm installed yet, the setup step fails the same way. v6 limits automatic caching to npm.",
    fix: "Install pnpm before setup-node, set `package-manager-cache: false`, or move to actions/setup-node@v6 or later.",
    source: SETUP_NODE_V5,
    fixable: false,
  },
  {
    id: "removed-transform-types-flag",
    severity: "error",
    title: "`--experimental-transform-types` was removed in Node 26",
    why: "Node.js 26.0.0 removed the flag (89f4b6cddb, #61803). Node 26 exits with `bad option: --experimental-transform-types` (or `is not allowed in NODE_OPTIONS`). Type stripping stays on by default but only handles erasable syntax.",
    fix: "Drop the flag. Code with enums, namespaces or parameter properties needs a build step (tsc) or a loader such as tsx.",
    source: TS_DOCS,
    fixable: false,
  },
  {
    id: "floating-node-version",
    severity: "note",
    title: "A floating Node version (node:lts, lts/*, latest) moved to 26 on 2026-10-28",
    why: "node:lts and lts/* follow the Active LTS line, which became Node 26 with 26.13.0 on 2026-10-28; latest, current and bare variants like node:alpine follow the Current line. The next move happens without a commit.",
    fix: "Pin a major (node:26-alpine, node-version: 26) and upgrade on purpose. `--fix --pin 26` rewrites the tag.",
    source: DOCKER_LTS,
    fixable: true,
  },
  {
    id: "engines-exclude-node26",
    severity: "warning",
    title: "`engines.node` does not allow the Node the repo runs on",
    why: "npm warns EBADENGINE when the running Node is outside `engines.node`, and installs fail outright with engine-strict (and in Yarn 1). A range like `^20 || ^22` or `<25` rules out Node 26.",
    fix: "Add 26 to the range (for example `^22 || ^24 || >=26`) once the tests pass on 26.",
    source: NPM_ENGINES,
    fixable: false,
  },
  {
    id: "node-version-mismatch",
    severity: "warning",
    title: "The repo pins one Node major, a Dockerfile or CI job runs another",
    why: "The .nvmrc / .node-version / volta pin is what developers test on; a node:lts image or an lts/* job moved to 26 on its own, so CI and production now run a major nobody tested locally.",
    fix: "Pin the image or job to the same major, or move the pin to 26 after testing.",
    source: DOCKER_LTS,
    fixable: false,
  },
  {
    id: "dependency-engines-exclude-node26",
    severity: "note",
    title: "Locked dependencies declare engines that leave out Node 26",
    why: "These packages' own `engines.node` ranges exclude 26.13.0; npm prints EBADENGINE for each one and engine-strict installs fail.",
    fix: "Update them to releases that allow Node 26, or check that they work on 26 and keep the warning.",
    source: NPM_ENGINES,
    fixable: false,
  },
  {
    id: "native-addon-rebuild",
    severity: "note",
    title: "Native addons must be rebuilt or have prebuilt binaries for NODE_MODULE_VERSION 147",
    why: "Node.js 26 moved NODE_MODULE_VERSION to 147 (75c3bcc3ec); Node 24 is 137 and Node 22 is 127. A compiled addon from an older major fails to load with `was compiled against a different Node.js version`.",
    fix: "Run `npm rebuild` (or reinstall) on Node 26, make sure each addon ships prebuilt binaries for Node 26 or the image has python3, make and g++ for node-gyp.",
    source: REL26,
    fixable: false,
  },
  {
    id: "node-modules-cache-key",
    severity: "warning",
    title: "node_modules is cached with a key that ignores the Node version",
    why: "Native addons in node_modules are built for one NODE_MODULE_VERSION (147 on Node 26). When lts/* moves, a cache key without the Node version restores modules built for the old ABI.",
    fix: "Put the Node version in the key (`${{ runner.os }}-node${{ steps.setup.outputs.node-version }}-${{ hashFiles('**/package-lock.json') }}`) or cache the package manager store instead (setup-node `cache:`).",
    source: REL26,
    fixable: false,
  },
  {
    id: "dep0193-stream-internals",
    severity: "error",
    dep: "DEP0193",
    title: "`require('_stream_*')` modules were removed in Node 26",
    why: "Node.js 26.0.0 moved DEP0193 (and DEP0125 for _stream_wrap) to End-of-Life: _stream_readable, _stream_writable, _stream_duplex, _stream_transform, _stream_passthrough and _stream_wrap are gone.",
    fix: "Import from `node:stream` instead: `require('node:stream').Readable`, `import { Transform } from 'node:stream'`.",
    source: `${DEPS}#dep0193-requirenode_stream_`,
    fixable: false,
  },
  {
    id: "dep0063-writeheader",
    severity: "error",
    dep: "DEP0063",
    title: "`response.writeHeader()` was removed in Node 26",
    why: "Node.js 26.0.0 moved DEP0063 to End-of-Life: ServerResponse.prototype.writeHeader() is gone, so the call throws `writeHeader is not a function`.",
    fix: "Call `response.writeHead()` instead (same arguments).",
    source: `${DEPS}#dep0063-serverresponseprototypewriteheader`,
    fixable: false,
  },
  {
    id: "dep0030-slowbuffer",
    severity: "error",
    dep: "DEP0030",
    title: "`SlowBuffer` was removed in Node 25",
    why: "Node.js 25.0.0 moved DEP0030 to End-of-Life: the SlowBuffer class has been removed.",
    fix: "Use `Buffer.allocUnsafeSlow(size)`. Official codemod: `npx codemod@latest @nodejs/slow-buffer-to-buffer-alloc-unsafe-slow`.",
    source: `${DEPS}#dep0030-slowbuffer`,
    fixable: false,
  },
  {
    id: "dep0176-fs-access-constants",
    severity: "error",
    dep: "DEP0176",
    title: "`fs.F_OK`, `fs.R_OK`, `fs.W_OK`, `fs.X_OK` were removed in Node 25",
    why: "Node.js 25.0.0 removed the F_OK / R_OK / W_OK / X_OK getters exposed directly on node:fs, so they read as undefined.",
    fix: "Use `fs.constants.F_OK` (or `fs.promises.constants`). Official codemod: `npx codemod@latest @nodejs/fs-access-mode-constants`.",
    source: `${DEPS}#dep0176-fsf_ok-fsr_ok-fsw_ok-fsx_ok`,
    fixable: false,
  },
  {
    id: "dep0147-rmdir-recursive",
    severity: "error",
    dep: "DEP0147",
    title: "`fs.rmdir(path, { recursive: true })` lost its recursive option in Node 25",
    why: "Node.js 25.0.0 moved DEP0147 to End-of-Life: fs.rmdir, fs.rmdirSync and fs.promises.rmdir no longer support `recursive`; on Node 26 the call throws ERR_INVALID_ARG_VALUE.",
    fix: "Use `fs.rm(path, { recursive: true, force: true })`. Official codemod: `npx codemod@latest @nodejs/rmdir`.",
    source: `${DEPS}#-recursive-true`,
    fixable: false,
  },
  {
    id: "dep0173-calltracker",
    severity: "error",
    dep: "DEP0173",
    title: "`assert.CallTracker` was removed in Node 25",
    why: "Node.js 25.0.0 moved DEP0173 to End-of-Life: the assert.CallTracker API has been removed.",
    fix: "Use mock functions from `node:test` (`mock.fn()` and `fn.mock.callCount()`).",
    source: `${DEPS}#dep0173-the-assertcalltracker-class`,
    fixable: false,
  },
  {
    id: "dep0094-assert-fail-args",
    severity: "error",
    dep: "DEP0094",
    title: "`assert.fail()` with more than one argument reached End-of-Life in Node 25",
    why: "Node.js 25.0.0 moved DEP0094 to End-of-Life: assert.fail(actual, expected, message, operator) is no longer supported; on Node 26 the extra arguments are dropped and the first one becomes the error message.",
    fix: "Pass one argument (`assert.fail('message')`) or use another node:assert method such as `assert.strictEqual(actual, expected, message)`.",
    source: `${DEPS}#dep0094-using-assertfail-with-more-than-one-argument`,
    fixable: false,
  },
  {
    id: "dep0160-multiple-resolves",
    severity: "error",
    dep: "DEP0160",
    title: "`process.on('multipleResolves')` was removed in Node 25",
    why: "Node.js 25.0.0 moved DEP0160 to End-of-Life: the event was removed, so the handler never runs.",
    fix: "Remove the listener; track settled promises in your own code if you need it.",
    source: `${DEPS}#dep0160-processonmultipleresolves-handler`,
    fixable: false,
  },
  {
    id: "dep0185-repl-without-new",
    severity: "error",
    dep: "DEP0185",
    title: "node:repl classes called without `new` reached End-of-Life in Node 25",
    why: "Node.js 25.0.0 moved DEP0185 to End-of-Life: REPLServer, Recoverable and the other node:repl classes must be instantiated with `new`.",
    fix: "Add `new` (`new repl.REPLServer(options)`) or use `repl.start()`. Official codemod: `npx codemod@latest @nodejs/repl-classes-with-new`.",
    source: `${DEPS}#dep0185-instantiating-noderepl-classes-without-new`,
    fixable: false,
  },
  {
    id: "dep0077-module-debug",
    severity: "error",
    dep: "DEP0077",
    title: "`Module._debug()` was removed in Node 25",
    why: "Node.js 25.0.0 moved DEP0077 to End-of-Life: Module._debug() has been removed.",
    fix: "Remove the call; use `NODE_DEBUG=module` to trace module loading.",
    source: `${DEPS}#dep0077-module_debug`,
    fixable: false,
  },
  {
    id: "dep0154-rsa-pss-hash",
    severity: "error",
    dep: "DEP0154",
    title: "RSA-PSS key generation options `hash` / `mgf1Hash` were removed in Node 25",
    why: "Node.js 25.0.0 moved DEP0154 to End-of-Life: generateKeyPair('rsa-pss') takes `hashAlgorithm` and `mgf1HashAlgorithm` only; `hash` throws ERR_INVALID_ARG_VALUE.",
    fix: "Rename `hash` to `hashAlgorithm` and `mgf1Hash` to `mgf1HashAlgorithm`. Official codemod: `npx codemod@latest @nodejs/crypto-rsa-pss-update`.",
    source: `${DEPS}#dep0154-rsa-pss-generate-key-pair-options`,
    fixable: false,
  },
  {
    id: "dep0132-worker-terminate-callback",
    severity: "error",
    dep: "DEP0132",
    title: "`worker.terminate(callback)` reached End-of-Life in Node 25",
    why: "Node.js 25.0.0 moved DEP0132 to End-of-Life: passing a callback to worker.terminate() is no longer supported; on Node 26 the callback is silently never called.",
    fix: "Use the returned promise (`await worker.terminate()`) or listen for the worker's 'exit' event.",
    source: `${DEPS}#dep0132-workerterminate-with-callback`,
    fixable: false,
  },
  {
    id: "dep0182-gcm-auth-tag",
    severity: "note",
    dep: "DEP0182",
    title: "GCM decryption without `authTagLength`: short tags are rejected since Node 26",
    why: "Node.js 26.0.0 moved DEP0182 to End-of-Life: decipher.setAuthTag() no longer accepts tags shorter than 16 bytes for AES-GCM unless authTagLength is set in createDecipheriv().",
    fix: "If your tags are shorter than 16 bytes, pass `{ authTagLength: <bytes> }` to `crypto.createDecipheriv()`.",
    source: `${DEPS}#dep0182-short-gcm-authentication-tags-without-explicit-authtaglength`,
    fixable: false,
  },
  {
    id: "dep0205-module-register",
    severity: "note",
    dep: "DEP0205",
    title: "`module.register()` prints a runtime deprecation warning on Node 26",
    why: "Node.js 26.0.0 made DEP0205 a runtime deprecation; module.register() will be removed in a future version.",
    fix: "Move the hooks to `module.registerHooks()` (synchronous, in-thread).",
    source: `${DEPS}#dep0205-moduleregister`,
    fixable: false,
  },
  {
    id: "dep0198-shake-output-length",
    severity: "note",
    dep: "DEP0198",
    title: "SHAKE-128/256 without `outputLength` prints a deprecation warning since Node 25",
    why: "Node.js 25.0.0 made DEP0198 a runtime deprecation: creating SHAKE digests without an explicit options.outputLength is deprecated.",
    fix: "Pass the length you rely on: `crypto.createHash('shake256', { outputLength: 32 })`.",
    source: `${DEPS}#dep0198-creating-shake-128-and-shake-256-digests-without-an-explicit-optionsoutputlength`,
    fixable: false,
  },
  {
    id: "dep0031-ecdh-setpublickey",
    severity: "note",
    dep: "DEP0031",
    title: "`ecdh.setPublicKey()` prints a deprecation warning since Node 25",
    why: "Node.js 25.0.0 made DEP0031 a runtime deprecation: the method is not useful in the ECDH API.",
    fix: "Drop the call; ECDH only needs the private key (`ecdh.setPrivateKey()`), the public key is derived from it.",
    source: `${DEPS}#dep0031-ecdhsetpublickey`,
    fixable: false,
  },
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function ruleMeta(id: string): RuleMeta {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`unknown rule ${id}`);
  return r;
}

export const SOURCES = { REL25, REL26, DIST } as const;
