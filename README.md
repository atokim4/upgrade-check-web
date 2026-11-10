# Upgrade check

A static page that tells you what the Nov-Dec 2026 upgrades break in a repository. Paste a public GitHub repo
(or pick a folder on your computer) and it lists each line that breaks, why, the source the rule is based on,
and a diff for the cases that can be rewritten safely.

**Live:** https://upgrade-check-2026.netlify.app

It checks four changes:

| Date | Change | Checker |
| --- | --- | --- |
| 2026-10-28 | Node.js 26 becomes LTS: no corepack, no Yarn 1 in `node:26` images, setup-node cache order, removed APIs | [node26-lts-upgrade](https://github.com/atokim4/node26-lts-upgrade) |
| 2026-10-30 | Supabase stops granting new tables to the Data API | [vibe-preflight](https://github.com/atokim4/vibe-preflight) (grants checks) |
| 2026-11-02 | Supabase CLI v3: removed commands, flags and `config.toml` sections | [supabase-cli-v3-upgrade](https://github.com/atokim4/supabase-cli-v3-upgrade) |
| 2026-12-01 | `@supabase/server/adapters/*` removed; direct writes to `cron.job` blocked | [vibe-preflight](https://github.com/atokim4/vibe-preflight) (breaking checks) |

The checks are the same code as those three CLIs. This page bundles their scan engines for the browser; it adds
no rules of its own.

## How it works

1. `owner/repo`, a GitHub URL, `owner/repo@ref` or a `/tree/<ref>` link is parsed into a repo and a ref.
2. Two unauthenticated GitHub REST calls: `GET /repos/{o}/{r}/commits/{ref}` (just the SHA) and
   `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`. GitHub allows 60 of these per hour per IP; the page shows
   how many are left and when the limit resets.
3. From the tree it picks what the rules read, in this order: CI workflows, Dockerfiles, `package.json`,
   `.nvmrc`, `supabase/config.toml` and other config; up to 2 lockfiles; up to 40 SQL files; then source files
   (Edge Functions and server code first) until 60 config and source files are read. The file contents come
   from `raw.githubusercontent.com`, which doesn't count against the API limit.
4. The three engines run on those files in the tab. A finding links to its line on GitHub at the scanned
   commit; fixable ones carry a unified diff, and each checker offers all its fixes as one patch for `git apply`.

The result says how many files it read and how many it left out. If a repo has more SQL files than the limit,
the grants checks are switched off rather than run on half a schema. For a full scan, run the CLIs:

```bash
npx github:atokim4/supabase-cli-v3-upgrade .
npx github:atokim4/node26-lts-upgrade .
npx github:atokim4/vibe-preflight --only breaking,grants-missing,grant-leak,grant-broad .
```

A folder from your computer (picker or drag and drop) is read the same way with much higher limits, skipping
`node_modules`, `.git` and build output. It never leaves the browser.

### Privacy

There is no backend. The page talks to `api.github.com` and `raw.githubusercontent.com` and nothing else;
the Content-Security-Policy in `public/_headers` enforces that (`connect-src` lists only those two). No analytics,
no cookies, no third-party fonts (IBM Plex is self-hosted). Private repositories can't be read: the page never
asks for a token.

## Stack

TypeScript (strict), Vite, no UI framework. DOM is built with a small `h()` helper that only ever sets text, so
repo contents can't inject HTML. Vitest for unit tests, Playwright (with an installed Chrome) for end-to-end
tests. Deployed as static files on Netlify.

```
src/
  engines/        the three scanners' browser-safe modules (copied by scripts/sync-engines.mjs)
  lib/            repo-input, github (REST + raw), select (what to read), loader, checks (runs the engines)
  ui/             dom helpers, render, drop (folder drag and drop)
  main.ts         wiring, URL state (?repo=owner/repo), progress
test/             unit tests (fake fetch, in-memory repos)
e2e/              Playwright against live public repos, plus a local sample folder
```

## Run it

Node 22 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
npm run check        # typecheck + unit tests + build
npm run build && npm run e2e   # end-to-end; CHROME_PATH=/path/to/chrome if it isn't /usr/bin/google-chrome
```

The e2e tests call GitHub (2 API requests per repo, 4 repos), pinned to fixed commits:

- `kpi-ua/schedule.kpi.ua@6d5e7ba14d`, the commit before its fix PR #631: `corepack enable` in `Dockerfile:5`.
- `vercel/nextjs-subscription-payments@bdd0813206`: an `[inbucket]` section in `supabase/config.toml`.
- `expressjs/express@43fca52d28`: nothing breaks.
- A repo that doesn't exist, and `e2e/fixtures/sample-app` as a local folder (no network at all).

### Updating the engines

The engines live in their own repos. Clone the three next to each other and run:

```bash
node scripts/sync-engines.mjs path/to/folder-with-the-three-repos
```

It copies each repo's `src/` minus the Node-only files (CLI, file system, Action, terminal reports) and records
the versions in `src/engines/versions.json`. Don't edit `src/engines/` by hand.

## Licence

MIT. A personal project by Sunnatulla E. Not affiliated with Supabase, GitHub or the Node.js project.
