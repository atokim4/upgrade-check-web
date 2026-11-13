# Upgrade check

A static page that tells you which 2026-27 shutdowns and upgrades hit a repository. Paste a public GitHub repo
(or pick a folder on your computer) and it lists each line that breaks, why, the source the rule is based on,
and a diff for the cases that can be rewritten safely.

**Live:** https://upgrade-check-2026.netlify.app

| Date | Change | Checker |
| --- | --- | --- |
| 2026-10-28 | Node.js 26 becomes LTS: no corepack, no Yarn 1 in `node:26` images, setup-node cache order, removed APIs | [node26-lts-upgrade](https://github.com/atokim4/node26-lts-upgrade) |
| 2026-10-30 | Supabase stops granting new tables to the Data API | [vibe-preflight](https://github.com/atokim4/vibe-preflight) (grants checks) |
| 2026-11-02 | Supabase CLI v3: removed commands, flags and `config.toml` sections | [supabase-cli-v3-upgrade](https://github.com/atokim4/supabase-cli-v3-upgrade) |
| 2026-11-12 | PostgreSQL 14's final release; `postgres:18` images keep data in `/var/lib/postgresql/18/docker` | [pg18-upgrade-check](https://github.com/atokim4/pg18-upgrade-check) |
| 2026-11-30 | Claude Sonnet 4.5 retires on the Claude API | [llm-retire-scan](https://github.com/atokim4/llm-retire-scan) |
| 2026-12-01 | Standalone Prisma Accelerate shuts down | [prisma-accelerate-exit](https://github.com/atokim4/prisma-accelerate-exit) |
| 2026-12-01 | `@supabase/server/adapters/*` removed; direct writes to `cron.job` blocked | [vibe-preflight](https://github.com/atokim4/vibe-preflight) (breaking checks) |
| 2026-12-01 | Gemini API routes `gemini-2.5-pro` and `gemini-2.5-flash` requests to other models | this page only |
| 2026-12-10 / 2027-01-10 | Val Town goes read-only, then shuts down | [deno-exit](https://github.com/atokim4/deno-exit) |
| 2027-01-01 | Google's Custom Search JSON API ends for existing customers | this page only |
| 2027-01-14 | OpenAI shuts down GPT-4o and GPT-4.1 (and `gpt-6-luna` needs `reasoning_effort: "none"` for tools) | [llm-retire-scan](https://github.com/atokim4/llm-retire-scan) |
| April 2027 | Deno Deploy is sunset | [deno-exit](https://github.com/atokim4/deno-exit) |
| not dated | n8n 3.0 removes nodes, modes and expressions | [n8n-v3-check](https://github.com/atokim4/n8n-v3-check) |

The Supabase and Node checkers run the same engines as their CLIs, including the fixes. The Prisma, LLM, Deno,
Postgres and n8n checkers run each CLI's own rule code where it is pure (model tables, text rules, YAML parsers,
workflow rules) and only detect: their fixers need a TypeScript syntax tree or the file system. Where a CLI rule
needs the syntax tree (Prisma's `$extends(withAccelerate())`, `cacheStrategy`; Deno KV and `Deno.cron`), the page
uses a text pattern instead and labels the finding "pattern match". Each checker shows the CLI command that
fixes or fully checks a local checkout. The Gemini 2.5 and Custom Search rules are small and exist only here;
their findings link to Google's own notices.

## How it works

1. `owner/repo`, a GitHub URL, `owner/repo@ref` or a `/tree/<ref>` link is parsed into a repo and a ref.
2. Two unauthenticated GitHub REST calls: `GET /repos/{o}/{r}/commits/{ref}` (just the SHA) and
   `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`. GitHub allows 60 of these per hour per IP; the page shows
   how many are left and when the limit resets.
3. From the tree it picks what the rules read, in this order: CI workflows, Dockerfiles, `package.json`,
   `.nvmrc`, `supabase/config.toml`, `schema.prisma`, `deno.json`, Compose/Helm/Kubernetes YAML, `.env.example`
   and other config; up to 2 lockfiles; up to 40 SQL files; up to 15 JSON files that may be n8n workflows; then
   JS/TS/Python source (Edge Functions, server code and files named after AI, search or database clients first)
   until 90 config and source files are read. Empty files are skipped. The file contents come from
   `raw.githubusercontent.com`, which doesn't count against the API limit. A file that fails twice is left out
   and named in the result.
4. Each checker is its own JavaScript chunk. A cheap test on the files decides whether it can find anything; if
   not, its code isn't downloaded and the result lists it under "not used". The rest run in the tab. A finding
   links to its line on GitHub at the scanned commit; fixable ones carry a unified diff, and each checker offers
   all its fixes as one patch for `git apply`.

`?repo=owner/repo` starts a check on load; `?only=prisma,llm` limits it to some checkers (ids: `supabase-cli-v3`,
`node26`, `preflight`, `prisma`, `llm`, `gemini-25`, `google-cse`, `deno`, `pg18`, `n8n`).

The result says how many files it read and how many it left out. If a repo has more SQL files than the limit,
the grants checks are switched off rather than run on half a schema. For a full scan, run the CLIs:

```bash
npx github:atokim4/supabase-cli-v3-upgrade .
npx github:atokim4/node26-lts-upgrade .
npx github:atokim4/vibe-preflight --only breaking,grants-missing,grant-leak,grant-broad .
npx github:atokim4/prisma-accelerate-exit .
npx github:atokim4/deno-exit .
```

`llm-retire-scan`, `pg18-upgrade-check` and `n8n-v3-check` run from a clone; each checker on the page shows the
exact command.

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
  engines/        the scanners' browser-safe modules (copied by scripts/sync-engines.mjs, never edited here)
  checkers/       one module per checker: runs an engine on the loaded files and writes the report
  lib/            repo-input, github (REST + raw), select (what to read), loader, checks (the lazy checker registry),
                  path-shim (the node:path helpers the engines use, aliased in vite.config.ts)
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
npm run check        # typecheck + unit tests + build + bundle budget (all JS under 250 KB gzip)
npm run build && npm run e2e   # end-to-end; CHROME_PATH=/path/to/chrome if it isn't /usr/bin/google-chrome
```

The e2e tests call GitHub (2 API requests per repo, 6 repos), pinned to fixed commits:

- `kpi-ua/schedule.kpi.ua@6d5e7ba14d`, the commit before its fix PR #631: `corepack enable` in `Dockerfile:5`.
- `vercel/nextjs-subscription-payments@bdd0813206`: an `[inbucket]` section in `supabase/config.toml`.
- `expressjs/express@43fca52d28`: nothing breaks.
- `Codehagen/Badget@16a677f953`: `@prisma/extension-accelerate` in `package.json:32`, `prisma generate --no-engine`,
  and `gpt-4o` calls.
- `google-gemini/gemini-fullstack-langgraph-quickstart@e34e569de4` with `?only=gemini-25`: `gemini-2.5-flash` in
  `backend/src/agent/configuration.py:19`.
- A repo that doesn't exist, and `e2e/fixtures/sample-app` as a local folder (no network at all).

### Updating the engines

The engines live in their own repos. Clone them next to each other and run:

```bash
node scripts/sync-engines.mjs path/to/folder-with-the-repos
```

For the three full engines it copies each repo's `src/` minus the Node-only files (CLI, file system, Action,
terminal reports); for the detect-only ones it copies a fixed list of pure modules. It records the versions in
`src/engines/versions.json`. Don't edit `src/engines/` by hand.

## Licence

MIT. A personal project by Sunnatulla E. Not affiliated with any of the companies or projects named here.
