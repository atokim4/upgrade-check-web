import { describe, expect, it } from "vitest";
import { check } from "../../src/checkers/google-cse.ts";
import { repoOf } from "../helpers/repo.ts";

const found = (files: Record<string, string>) => check(repoOf(files)).findings.map((f) => `${f.rule}@${f.file}:${f.line}`);

describe("google-cse checker", () => {
  it("finds direct calls, API clients, LangChain wrappers and the engine ID setting", () => {
    expect(
      found({
        "search.py": "import requests\nurl = 'https://www.googleapis.com/customsearch/v1'\nr = requests.get(url, params={'key': k, 'cx': cx, 'q': q})\n",
        "client.py": 'from googleapiclient.discovery import build\nservice = build("customsearch", "v1", developerKey=key)\nres = service.cse().list(q=q, cx=cx).execute()\n',
        "agent.py": "from langchain_google_community import GoogleSearchAPIWrapper\nsearch = GoogleSearchAPIWrapper()\n",
        "src/tool.ts": 'import { GoogleCustomSearch } from "@langchain/community/tools/google_custom_search";\n',
        "src/node.ts": 'import { google } from "googleapis";\nconst cs = google.customsearch("v1");\n',
        ".env.example": "GOOGLE_API_KEY=\nGOOGLE_CSE_ID=\n",
      }),
    ).toEqual([
      "cse-env@.env.example:2",
      "cse-langchain@agent.py:1",
      "cse-langchain@agent.py:2",
      "cse-client@client.py:2",
      "cse-client@client.py:3",
      "cse-endpoint@search.py:2",
      "cse-client@src/node.ts:2",
      "cse-langchain@src/tool.ts:1",
    ]);
  });

  it("keeps the advice neutral: no links to search vendors", () => {
    const [f] = check(repoOf({ "a.py": "u = 'https://www.googleapis.com/customsearch/v1'\n" })).findings;
    expect(f!.fix).toMatch(/Vertex AI Search/);
    expect(f!.fix).toMatch(/SearXNG/);
    expect(f!.fix).not.toMatch(/https?:\/\//);
    expect(f!.sourceUrl).toBe("https://developers.google.com/custom-search/v1/overview");
  });

  it("has no false positives on other search APIs, comments and docs", () => {
    expect(
      found({
        "serp.py": "from serpapi import GoogleSearch\nsearch = GoogleSearch({'q': q})\n",
        "brave.ts": 'fetch("https://api.search.brave.com/res/v1/web/search?q=" + q)\n',
        "old.py": "# we used www.googleapis.com/customsearch/v1 before\n",
        "README.md": "Set GOOGLE_CSE_ID\n",
        "CHANGELOG.json": '{"note": "customsearch/v1 removed"}',
      }),
    ).toEqual([]);
  });
});
