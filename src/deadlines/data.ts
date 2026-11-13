import type { CheckerId } from "../lib/types.ts";

/**
 * Every shutdown and breaking release the scanner checks, in one place. The /deadlines page, the per-deadline
 * pages and sitemap.xml are built from this list. Dates were re-read on the official pages on `READ_ON`.
 * Page copy may contain inline HTML (`<code>`, `<a>`); it is written here by hand, never from user input.
 */

export const READ_ON = "2026-11-13";
export const SITE = "https://upgrade-check-2026.netlify.app";

export interface Source {
  url: string;
  /** Who publishes it, e.g. "OpenAI deprecations page". */
  label: string;
}

export interface DeadlinePage {
  /** URL path without slashes, e.g. "gpt-4o-shutdown". */
  slug: string;
  /** <title>, under ~65 characters. */
  title: string;
  /** Meta description, under ~160 characters. */
  description: string;
  h1: string;
  /** Short name for the breadcrumb. */
  crumb: string;
  intro: string[];
  breaks: string[];
  fix: string[];
  /** What the prefilled scanner looks for, one sentence. */
  scans: string;
  /** A public repo the scanner finds something in, pinned to the commit we checked. */
  example: string;
  /** Official pages for facts beyond the deadline's own source. */
  moreSources?: Source[];
  /** When this page's own sources were last re-read, if later than `READ_ON`. */
  readOn?: string;
}

export interface Deadline {
  id: string;
  /** Short name for the timetable row. */
  name: string;
  /** What happens on the day, one sentence. */
  what: string;
  /** YYYY-MM-DD, or null when the vendor hasn't set a date. */
  date: string | null;
  /** The vendor gives a period, not a day; `date` is our estimate and the UI says "about". */
  approx?: boolean;
  source: Source;
  checkers: CheckerId[];
  /** Slug of the explainer page, if it has one. */
  page?: string;
}

/** Names as the scanner shows them (test/deadlines.test.ts keeps these in step with CHECKERS). */
export const CHECKER_NAMES: Record<CheckerId, string> = {
  "supabase-cli-v3": "Supabase CLI v3",
  node26: "Node.js 26 LTS",
  preflight: "Supabase platform changes",
  prisma: "Prisma Accelerate shutdown",
  llm: "OpenAI and Claude model retirements",
  "gemini-25": "Gemini 2.5 on the Gemini API",
  "google-cse": "Google Custom Search JSON API",
  deno: "Deno Deploy and Val Town",
  pg18: "Postgres 18 in Docker",
  n8n: "n8n 3.0 workflows",
  eslint10: "ESLint 10",
};

export const DEADLINES: readonly Deadline[] = [
  {
    id: "node26-lts",
    name: "Node.js 26 becomes LTS",
    what: "No corepack in Node 26, and no Yarn in the node:26 Docker images.",
    date: "2026-10-28",
    source: {
      url: "https://github.com/nodejs/Release",
      label: "Node.js release schedule",
    },
    checkers: ["node26"],
  },
  {
    id: "supabase-grants",
    name: "Supabase Data API grants change",
    what: "Existing projects stop exposing new tables to the Data and GraphQL APIs automatically.",
    date: "2026-10-30",
    source: {
      url: "https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically",
      label: "Supabase changelog",
    },
    checkers: ["preflight"],
  },
  {
    id: "supabase-cli-v3",
    name: "Supabase CLI v3",
    what: "Commands, flags and config.toml sections removed in CI and scripts.",
    date: "2026-11-02",
    source: {
      url: "https://github.com/supabase/cli/releases/tag/v3.0.0",
      label: "Supabase CLI v3.0.0 release",
    },
    checkers: ["supabase-cli-v3"],
  },
  {
    id: "pg14-eol",
    name: "PostgreSQL 14 final release",
    what: "No more fixes for 14; the postgres:18 image keeps data in a new directory.",
    date: "2026-11-12",
    source: {
      url: "https://www.postgresql.org/support/versioning/",
      label: "PostgreSQL versioning policy",
    },
    checkers: ["pg18"],
    page: "postgres-18-docker-upgrade",
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 retires",
    what: "Requests to claude-sonnet-4-5-20250929 fail on the Claude API.",
    date: "2026-11-30",
    source: {
      url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
      label: "Anthropic model deprecations",
    },
    checkers: ["llm"],
    page: "claude-sonnet-4-5-retirement",
  },
  {
    id: "prisma-accelerate",
    name: "Prisma Accelerate shuts down",
    what: "Standalone Accelerate is retired; prisma:// URLs need a direct or pooled database URL.",
    date: "2026-12-01",
    source: {
      url: "https://www.prisma.io/docs/accelerate/keep-your-database",
      label: "Prisma docs",
    },
    checkers: ["prisma"],
    page: "prisma-accelerate-shutdown",
  },
  {
    id: "gemini-2-5",
    name: "Gemini 2.5 Pro and Flash rerouted",
    what: "Requests are answered by gemini-3.8-flash and gemini-3.5-flash-lite instead.",
    date: "2026-12-01",
    source: {
      url: "https://aistudio.google.com/docs/deprecations",
      label: "Gemini API deprecations",
    },
    checkers: ["gemini-25"],
    page: "gemini-2-5-shutdown",
  },
  {
    id: "gpt-image-1-5",
    name: "GPT Image 1.5 and 1 mini shut down",
    what: "gpt-image-1.5, gpt-image-1-mini and chatgpt-image-latest stop; gpt-image-2.6-sunburst or -flare replace them.",
    date: "2026-12-01",
    source: {
      url: "https://developers.openai.com/api/docs/deprecations",
      label: "OpenAI deprecations page",
    },
    checkers: ["llm"],
    page: "gpt-5-o3-shutdown",
  },
  {
    id: "supabase-server-adapters",
    name: "@supabase/server adapters removed",
    what: "The framework adapters are removed from the package.",
    date: "2026-12-01",
    source: {
      url: "https://supabase.com/changelog/supabase-server-adapters-deprecated",
      label: "Supabase changelog",
    },
    checkers: ["preflight"],
  },
  {
    id: "val-town-read-only",
    name: "Val Town goes read-only",
    what: "Code can't be edited any more; apps keep running until January 10.",
    date: "2026-12-10",
    source: {
      url: "https://docs.val.town/migration",
      label: "Val Town migration guide",
    },
    checkers: ["deno"],
    page: "deno-deploy-val-town-exit",
  },
  {
    id: "gpt-5-o3",
    name: "GPT-5 and o3 shut down",
    what: "gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-pro, o3 and o3-pro stop; gpt-6.1-sol, gpt-6.1-terra and gpt-6-luna replace them.",
    date: "2026-12-11",
    source: {
      url: "https://developers.openai.com/api/docs/deprecations",
      label: "OpenAI deprecations page",
    },
    checkers: ["llm"],
    page: "gpt-5-o3-shutdown",
  },
  {
    id: "google-cse",
    name: "Google Custom Search JSON API ends",
    what: "Existing customers lose the API; it is already closed to new ones.",
    date: "2027-01-01",
    source: {
      url: "https://developers.google.com/custom-search/v1/overview",
      label: "Google Custom Search overview",
    },
    checkers: ["google-cse"],
    page: "google-custom-search-api-shutdown",
  },
  {
    id: "val-town-off",
    name: "Val Town shuts down",
    what: "Apps on Val Town stop running.",
    date: "2027-01-10",
    source: {
      url: "https://docs.val.town/migration",
      label: "Val Town migration guide",
    },
    checkers: ["deno"],
    page: "deno-deploy-val-town-exit",
  },
  {
    id: "gpt-4o",
    name: "GPT-4o and GPT-4.1 shut down",
    what: "gpt-4o, gpt-4o-mini, gpt-4.1 and gpt-4.1-mini snapshots stop answering; gpt-6-luna replaces them.",
    date: "2027-01-14",
    source: {
      url: "https://developers.openai.com/api/docs/deprecations",
      label: "OpenAI deprecations page",
    },
    checkers: ["llm"],
    page: "gpt-4o-shutdown",
  },
  {
    id: "deno-deploy",
    name: "Deno Deploy shuts down",
    what: "Announced on October 9, 2026 as “six months” away; no exact day yet.",
    date: "2027-04-09",
    approx: true,
    source: { url: "https://deno.com/blog/cloudflare", label: "Deno blog" },
    checkers: ["deno"],
    page: "deno-deploy-val-town-exit",
  },
  {
    id: "eslint-9-eol",
    name: "ESLint 9 end of life",
    what: "ESLint 9 gets no more fixes; ESLint 10 drops eslintrc and changes config lookup.",
    date: "2026-08-06",
    source: { url: "https://eslint.org/version-support/", label: "ESLint version support" },
    checkers: ["eslint10"],
    page: "eslint-10-upgrade",
  },
  {
    id: "n8n-3",
    name: "n8n 3.0",
    what: "Removed nodes and expression helpers; 3.0.0 is in early access with no release date.",
    date: null,
    source: {
      url: "https://docs.n8n.io/changelog/v30-breaking-changes/",
      label: "n8n 3.0 breaking changes",
    },
    checkers: ["n8n"],
    page: "n8n-3-migration",
  },
];

export const PAGES: readonly DeadlinePage[] = [
  {
    slug: "gpt-5-o3-shutdown",
    title: "GPT-5 and o3 shut down on December 11, 2026",
    description:
      "OpenAI shuts down gpt-5, gpt-5-mini, gpt-5-nano, o3 and their pro models on Dec 11, 2026. What the GPT-6 swap breaks, and a repo scanner.",
    h1: "GPT-5 and o3 shut down on December 11, 2026",
    crumb: "GPT-5 and o3",
    intro: [
      "OpenAI's deprecations page lists December 11, 2026 as the shutdown date for <code>gpt-5</code>, <code>gpt-5-mini</code>, <code>gpt-5-nano</code>, <code>gpt-5-pro</code>, <code>o3</code> and <code>o3-pro</code>, with their dated snapshots. Each one gets its own replacement: <code>gpt-6.1-sol</code> for gpt-5 and o3, <code>gpt-6.1-terra</code> for gpt-5-mini, <code>gpt-6-luna</code> for gpt-5-nano. The two pro models become <code>gpt-6.1-sol</code> with <code>reasoning.mode: \"pro\"</code>, in the Responses API only. Ten days earlier, on December 1, <code>gpt-image-1.5</code>, <code>gpt-image-1-mini</code> and <code>chatgpt-image-latest</code> go too.",
    ],
    breaks: [
      "The new models don't take the same requests. On <code>gpt-6.1-sol</code> and <code>gpt-6.1-terra</code>, tool calling needs the Responses API, so a Chat Completions call that sends <code>tools</code> fails after a plain swap. <code>gpt-6.1-sol</code> has no <code>none</code> effort, which means <code>temperature</code> and <code>top_p</code> have to go. No GPT-6 model lists <code>minimal</code> effort.",
      "<code>gpt-5.1</code>, <code>gpt-5.2</code> and the GPT-5.6 models are not on this list, so the scanner matches IDs whole and leaves them alone (gpt-5.1 has its own date, April 1, 2027).",
    ],
    fix: [
      "Swap the ID where the call has no tools on Chat Completions and no sampling settings. Move tool calls to Responses, and replace <code>minimal</code> with <code>low</code> as OpenAI's migration guide suggests. For the image models pick Sunburst for detailed work or Flare for fast iteration, on the Image API.",
    ],
    moreSources: [
      {
        url: "https://developers.openai.com/api/docs/guides/latest-model",
        label: "OpenAI latest-model guide",
      },
      {
        url: "https://developers.openai.com/api/docs/guides/reasoning",
        label: "OpenAI reasoning guide",
      },
    ],
    scans: "OpenAI model IDs that shut down, and calls that break on gpt-6.1-sol, gpt-6.1-terra or gpt-6-luna (tools, sampling, effort, pro mode).",
    example: "pixeltable/pixelagent@b862c3eaae1b",
    readOn: "2026-11-14",
  },
  {
    slug: "gpt-4o-shutdown",
    title: "GPT-4o and GPT-4.1 shut down on January 14, 2027",
    description:
      "OpenAI shuts down the GPT-4o and GPT-4.1 snapshots on Jan 14, 2027. What breaks when you switch to gpt-6-luna, and a scanner for your repo.",
    h1: "GPT-4o and GPT-4.1 shut down on January 14, 2027",
    crumb: "GPT-4o and GPT-4.1",
    intro: [
      "OpenAI's deprecations page gives January 14, 2027 as the shutdown date for <code>gpt-4o-2024-08-06</code>, <code>gpt-4o-2024-11-20</code>, <code>gpt-4o-mini-2024-07-18</code>, <code>gpt-4.1-2025-04-14</code> and <code>gpt-4.1-mini-2025-04-14</code>. The notice went out on October 14, 2026, and the replacement it recommends for all five is <code>gpt-6-luna</code>. Two older snapshots, <code>gpt-4o-2024-05-13</code> and <code>gpt-4.1-nano</code>, already shut down on October 23.",
    ],
    breaks: [
      'Changing the model string is the easy half. <code>gpt-6-luna</code> is a reasoning model, and on Chat Completions it accepts function tools only when <code>reasoning_effort</code> is <code>"none"</code>. The SDKs leave the default (medium), so a tool call that worked on GPT-4o fails after a plain swap. <code>temperature</code> and <code>top_p</code> are rejected for the same reason unless effort is <code>"none"</code>.',
      "The scanner flags the short names too (<code>gpt-4o</code>, <code>gpt-4o-mini</code>, <code>gpt-4.1</code>, <code>gpt-4.1-mini</code>) and fine-tunes built on these models. I ran the command-line version on 21 public repos and read every finding by hand before trusting it here.",
    ],
    fix: [
      'Swap the ID, then go through each call that sends tools or sampling parameters: set <code>reasoning_effort: "none"</code> there, or move the call to the Responses API if you want the model to reason. Run a sample of your real prompts on <code>gpt-6-luna</code> before the date, because answers and token use will differ.',
    ],
    moreSources: [
      {
        url: "https://developers.openai.com/api/docs/guides/reasoning",
        label: "OpenAI reasoning guide",
      },
    ],
    scans: "OpenAI model IDs that shut down, fine-tunes on them, and calls that break on gpt-6-luna (tools, sampling, effort).",
    example: "father-bot/chatgpt_telegram_bot@3631d6534f2c",
  },
  {
    slug: "claude-sonnet-4-5-retirement",
    title: "Claude Sonnet 4.5 retires on November 30, 2026",
    description:
      "claude-sonnet-4-5-20250929 retires on the Claude API on Nov 30, 2026. The replacement, the sampling parameters that now return 400, and a repo scanner.",
    h1: "Claude Sonnet 4.5 retires on November 30, 2026",
    crumb: "Claude Sonnet 4.5",
    intro: [
      "On September 30, 2026 Anthropic told developers that <code>claude-sonnet-4-5-20250929</code> retires on November 30, 2026. Requests to a retired model fail. The recommended replacement is <code>claude-sonnet-5-5</code>.",
      "That date covers Anthropic's own platforms: the Claude API, Claude Platform on AWS, Anthropic-managed Claude on Google Cloud, and Microsoft Foundry. Amazon Bedrock and the Google-managed models on Google Cloud set their own schedules, so check their model tables if you call Claude through them.",
    ],
    breaks: [
      "Newer models refuse some requests the old one took. In API version <code>2026-10-21</code>, <code>temperature</code>, <code>top_p</code> and <code>top_k</code> were removed and return a 400 error. On earlier API versions, Claude 4.7 and later models return the same error when one of them is set to a non-default value. Manual thinking budgets (<code>budget_tokens</code>) also get a 400 on Claude 4.7 and later.",
      "Code that takes <code>content[0].text</code> as the answer is fragile too: with thinking on, the first block of the reply is not the text.",
    ],
    fix: [
      "Change the ID to <code>claude-sonnet-5-5</code>, remove custom sampling values and steer with the prompt instead, and read the reply's text block by its type rather than its position. Anthropic's migration guide covers the thinking settings for the newer models.",
    ],
    scans: "Claude model IDs that retire or are already retired, custom sampling parameters, manual thinking budgets and content[0] reads.",
    example: "father-bot/chatgpt_telegram_bot@3631d6534f2c",
    moreSources: [
      {
        url: "https://platform.claude.com/docs/en/about-claude/models/migration-guide",
        label: "Anthropic migration guide",
      },
    ],
  },
  {
    slug: "prisma-accelerate-shutdown",
    title: "Prisma Accelerate shuts down on December 1, 2026",
    description:
      "Standalone Prisma Accelerate retires on Dec 1, 2026. What a prisma:// URL swap misses (edge entries, caching calls, CI flags) and a scanner for your repo.",
    h1: "Prisma Accelerate shuts down on December 1, 2026",
    crumb: "Prisma Accelerate",
    intro: [
      "Prisma's docs say standalone Prisma Accelerate will be retired on December 1, 2026. Every app that connects through a <code>prisma://</code> URL has to point at its database before then: a direct URL for long-running servers, a pooled one for serverless, and a setup that has been checked for edge runtimes.",
    ],
    breaks: [
      "The URL is the easy part. I scanned 33 public apps that use Accelerate and checked every finding by hand: 23 of them need more than deleting the import, the <code>$extends(withAccelerate())</code> call and the package.",
      "The common extras were edge entry points that reach Prisma Client through imports (14 apps), Accelerate URLs left in <code>.env.example</code>, READMEs or tests (14), <code>@prisma/client/edge</code> imports (8), and <code>prisma generate --no-engine</code> in scripts, Dockerfiles or CI (7). Five apps used the caching API, with 31 <code>cacheStrategy</code> calls between them.",
    ],
    fix: [
      "Prisma's own checklist: swap the URL in every environment and keep a separate direct URL for migrations if you use a pooler; remove the extension, the <code>accelerateUrl</code> option and the package; regenerate the client; delete <code>cacheStrategy</code>, <code>withAccelerateInfo()</code> and <code>$accelerate</code> calls, since queries now go straight to the database. Load-test in staging and keep the old config as a rollback until production is stable.",
    ],
    scans: "The Accelerate extension, prisma:// URLs, edge client imports, generate flags in CI and Docker, and caching calls.",
    example: "Codehagen/Badget@16a677f95361",
  },
  {
    slug: "gemini-2-5-shutdown",
    title: "Gemini 2.5 Pro and Flash are rerouted on December 1, 2026",
    description:
      "From Dec 1, 2026 the Gemini API answers gemini-2.5-pro with gemini-3.8-flash and gemini-2.5-flash with gemini-3.5-flash-lite. Find the IDs in your repo.",
    h1: "Gemini 2.5 Pro and Flash get rerouted on December 1, 2026",
    crumb: "Gemini 2.5",
    intro: [
      "Google's Gemini API deprecations page lists December 1, 2026 for <code>gemini-2.5-pro</code> and <code>gemini-2.5-flash</code>. The requests won't fail. From that day the API sends <code>gemini-2.5-pro</code> requests to <code>gemini-3.8-flash</code> and <code>gemini-2.5-flash</code> requests to <code>gemini-3.5-flash-lite</code>, billed at the new model's rates. Both also leave the model list in Google AI Studio.",
      "<code>gemini-2.5-flash-lite</code> is not deprecated and stays available until further notice. Google calls the listed dates the earliest possible ones and says exact dates are announced in advance.",
    ],
    breaks: [
      "Nothing throws, so your error logs stay quiet. A pipeline tuned on 2.5 Pro starts getting a Flash model's answers, and a 2.5 Flash workload moves to a Flash-Lite model. Prompts, output length limits and quality checks written for the old model may not hold.",
    ],
    fix: [
      "Pick the next model yourself instead of letting the routing pick it. Change the ID in code and config, rerun your evaluation or a sample of real prompts, and work out the cost at the new model's prices. The scanner finds the 2.5 Pro and Flash IDs, preview IDs included, and leaves <code>-flash-lite</code> alone.",
    ],
    scans: "gemini-2.5-pro and gemini-2.5-flash model IDs (and their previews) in code and config, not -flash-lite.",
    example: "google-gemini/gemini-fullstack-langgraph-quickstart@e34e569de465",
  },
  {
    slug: "google-custom-search-api-shutdown",
    title: "Google Custom Search JSON API ends on January 1, 2027",
    description:
      "Google's Custom Search JSON API is closed to new customers and ends for existing ones on Jan 1, 2027. Find every call in your repo and compare the options.",
    h1: "Google's Custom Search JSON API ends on January 1, 2027",
    crumb: "Google Custom Search API",
    intro: [
      "The Custom Search JSON API is closed to new customers, and Google's overview page says existing customers have until January 1, 2027 to move to something else. That covers direct calls to <code>www.googleapis.com/customsearch/v1</code>, the <code>customsearch</code> client in Google's API libraries, and wrappers built on top of it, such as LangChain's <code>GoogleSearchAPIWrapper</code> with its <code>GOOGLE_CSE_ID</code> setting.",
    ],
    breaks: [
      "Anything that starts from a Google query stops working on that day: site search boxes, research agents that cite web pages, tools that collect links for later processing.",
    ],
    fix: [
      "Google suggests Vertex AI Search if you search up to 50 domains, and asks customers who need full web search to contact them. Other routes are a self-hosted SearXNG instance or a paid web search API (Brave Search, or one of the SERP APIs). Results, quotas, terms and prices differ between them, so try two or three on your own queries before you choose.",
      "The scanner lists every place that needs that decision: the endpoint, the client, the LangChain wrapper and the search engine ID setting.",
    ],
    scans: "Calls to the customsearch/v1 endpoint, Custom Search API clients, LangChain Google Search wrappers and GOOGLE_CSE_ID settings.",
    example: "assafelovic/gpt-researcher@ddd4db36208d",
  },
  {
    slug: "deno-deploy-val-town-exit",
    title: "Val Town and Deno Deploy shut down: moving to Node",
    description:
      "Val Town is read-only from Dec 10, 2026 and off on Jan 10, 2027; Deno Deploy shuts down around April 2027. What a move to Node involves, and a repo scanner.",
    h1: "Val Town and Deno Deploy are shutting down",
    crumb: "Val Town and Deno Deploy",
    intro: [
      "Val Town's migration guide says code becomes read-only on December 10, 2026 and the service shuts down on January 10, 2027. Apps keep running until then. It points people to Node, Bun, or a provider runtime such as Cloudflare Workers or Vercel Functions.",
      "Deno announced on October 9, 2026 that its team is joining Cloudflare, and that Deno Deploy “will continue operating for six months before shutting down”. That puts the end around April 2027; the post gives no exact day.",
    ],
    breaks: [
      "Moving a Deno app to Node means replacing <code>Deno.*</code> calls, URL and <code>jsr:</code> imports, and <code>deno.json</code> tasks. Most of that is mechanical. Deno KV, <code>Deno.cron</code> and Fresh are not, because Node has no built-in equivalent.",
      "I ran a Deno-to-Node codemod on 27 public Deno repos. <code>npm install</code> worked in all 27 afterwards and <code>tsc</code> came out clean in 7. Deno KV showed up in 7 of them and Fresh in 3; those always needed a person to decide.",
    ],
    fix: [
      "Start with an inventory: the scanner flags Deploy config, KV, cron, Fresh and Val Town imports, and counts the Deno runtime calls. Let a tool do the mechanical rewrites, and decide early where KV data and scheduled jobs will live, since that choice shapes the rest of the move.",
    ],
    scans: "Deno Deploy config, Deno KV, Deno.cron, Fresh, Val Town imports, and how much of the code uses the Deno runtime.",
    example: "0f-0b/kv-relay@076195780df5",
  },
  {
    slug: "postgres-18-docker-upgrade",
    title: "Postgres 18 in Docker: the data directory moved",
    description:
      "PostgreSQL 14 is past its final release, and the postgres:18 image keeps data in a new path. The volume mistakes that lose data, and a compose file scanner.",
    h1: "Upgrading to Postgres 18 in Docker without losing the data",
    crumb: "Postgres 18 in Docker",
    intro: [
      "PostgreSQL 14 had its final release on November 12, 2026, so projects still on it are moving up, often straight to 18. From 18, the official <code>postgres</code> image keeps its data in <code>/var/lib/postgresql/18/docker</code> instead of <code>/var/lib/postgresql/data</code>.",
    ],
    breaks: [
      "A compose file that still mounts a volume at <code>/var/lib/postgresql/data</code> makes the entrypoint exit before <code>initdb</code> on a first start. If no mount covers the data directory, the data goes to the image's anonymous volume and disappears when the container is recreated.",
      "Floating tags such as <code>latest</code> have pointed at 18 since September 2025, and 18 can't open data written by 17 or older. 18 also turns data checksums on by default, and <code>pg_upgrade</code> stops when the old cluster has them off.",
      "I checked 52 open pull requests in public repos that bump Postgres to 18. 41 of them still mounted <code>/var/lib/postgresql/data</code>.",
    ],
    fix: [
      "Pin the major version in the image tag. Mount the volume at <code>/var/lib/postgresql</code>, or point <code>PGDATA</code> inside the mount you already have. Then move the data itself with <code>pg_upgrade</code> or a dump and restore into a new volume, with a backup taken first.",
    ],
    scans:
      "Postgres images in compose files, Dockerfiles, Helm and Kubernetes manifests: old data mounts, missing mounts, floating tags and majors past their final release.",
    example: "3Corners-Labs/OpenPlanner@b43dfb83eb11",
    moreSources: [
      {
        url: "https://github.com/docker-library/postgres/pull/1259",
        label: "docker-library/postgres pull request 1259 (new data path)",
      },
      {
        url: "https://www.postgresql.org/docs/18/release-18.html",
        label: "PostgreSQL 18 release notes",
      },
    ],
  },
  {
    slug: "eslint-10-upgrade",
    title: "ESLint 10 upgrade: what breaks after the version bump",
    description:
      "ESLint 9 reached end of life on August 6, 2026. What stops ESLint 10 from linting anything after a bump PR, and a file scanner for your repo.",
    h1: "ESLint 10: what breaks when the bump PR lands",
    crumb: "ESLint 10",
    intro: [
      "ESLint 9 reached end of life on August 6, 2026, so Renovate and Dependabot are opening ESLint 10 pull requests everywhere. There is no new deadline here: if one of these breaks your lint, it is broken already, and the question is whether your CI tells you.",
    ],
    breaks: [
      "ESLint 10 reads only <code>eslint.config.*</code>, so an <code>.eslintrc</code> repo stops with \"Could not find config file\". It also no longer installs <code>@eslint/js</code>, <code>@eslint/eslintrc</code> or <code>globals</code> for you, so a config that imports them without declaring them fails to load. Custom parsers must provide <code>addGlobals()</code> (@babel/eslint-parser 7 does not), typescript-eslint before 8.54 extends a class that was removed, and plugins that read <code>context.parserOptions</code> crash, eslint-plugin-import 2.32.0 among them.",
      "I checked 68 open ESLint 10 bump pull requests in public repos by hand: 45 of them lint zero files after the bump, and 7 of those 45 showed no failed check on the PR.",
    ],
    fix: [
      "Declare every package your config imports. Port eslintrc with <code>npx @eslint/migrate-config</code> and review the result. Upgrade typescript-eslint to 8.56 or newer, and keep ESLint 9 where a parser or plugin has no ESLint 10 release yet, or switch it (eslint-plugin-import-x). Then compare a real ESLint 9 and 10 run of the same code with the CLI linked below.",
    ],
    scans:
      "eslintrc-only configs, undeclared @eslint/js, @eslint/eslintrc and globals imports, old typescript-eslint, .eslintignore, eslint-env comments, removed CLI flags and Node versions ESLint 10 does not support.",
    example: "aggre/ullr@e51828561fc4",
    moreSources: [
      { url: "https://eslint.org/docs/latest/use/migrate-to-10.0.0", label: "ESLint v10 migration guide" },
      { url: "https://typescript-eslint.io/users/dependency-versions", label: "typescript-eslint dependency versions" },
    ],
  },
  {
    slug: "n8n-3-migration",
    title: "n8n 3.0 breaking changes: check your workflow JSON",
    description:
      "n8n 3.0 removes nodes such as Function, Cron and Item Lists plus $getPairedItem. Check exported workflow JSON in a repo for what breaks, without an instance.",
    h1: "n8n 3.0: what breaks in your workflows",
    crumb: "n8n 3.0",
    intro: [
      "n8n 3.0 has no release date yet; its breaking-changes page says 3.0.0 is available as an early access release. Workflows that use a removed node fail, and published ones stop activating.",
    ],
    breaks: [
      "The removed nodes include the legacy Function, Function Item and Item Lists nodes, Cron and Interval (use Schedule Trigger), HTML Extract, Read PDF, Workflow Trigger (use n8n Trigger) and AI Transform. Version 1 of the AI Agent node and Edit Image versions 1 and 1.1 are gone as well. In expressions, <code>$getPairedItem</code> is removed; use <code>$('&lt;node-name&gt;').item</code>, <code>.itemMatching()</code> or <code>.pairedItem()</code>.",
      "I checked all 14,139 public templates in the n8n gallery offline: 7.9% break on 3.0, and those templates hold 26.1% of all template views.",
    ],
    fix: [
      "On a running instance, Settings > Migration Report lists the affected workflows. If you keep exported workflow JSON in a repo, the scanner reads each <code>*.json</code> file with n8n nodes and names every node and expression to change, with its replacement.",
    ],
    scans: "Exported n8n workflow JSON: removed nodes, removed node versions and removed expression helpers.",
    example: "enescingoz/awesome-n8n-templates@827110332c21",
  },
];

/** The deadlines a page covers, earliest first. */
export const deadlinesFor = (slug: string): Deadline[] => DEADLINES.filter((d) => d.page === slug);
