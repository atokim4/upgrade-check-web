import { describe, expect, it } from "vitest";
import { check } from "../../src/checkers/perspective.ts";
import { runChecks } from "../../src/lib/checks.ts";
import { planReads } from "../../src/lib/select.ts";
import { repoOf } from "../helpers/repo.ts";

const found = (files: Record<string, string>) =>
  check(repoOf(files), "2026-11-14").findings.map((f) => `${f.rule}@${f.file}:${f.line}`);

describe("perspective checker", () => {
  it("finds endpoints, Google clients, packages and settings defaults", () => {
    expect(
      found({
        "lm_eval/tasks/realtoxicityprompts/metric.py":
          'url = f"https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key={API_KEY}"\n',
        "src/helm/clients/perspective_api_client.py":
          'discovery.build(\n    "commentanalyzer",\n    "v1alpha1",\n    discoveryServiceUrl="https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1",\n)\n',
        "package.json": '{\n  "dependencies": {\n    "perspective-api-client": "^3.1.0"\n  }\n}\n',
        "common/lib/constants.ts": 'export const TOXICITY_ENDPOINT_DEFAULT =\n  "https://commentanalyzer.googleapis.com/v1alpha1";\n',
        "README.md": "Uses https://commentanalyzer.googleapis.com\n",
        "tests/test_metric.py": 'URL = "https://commentanalyzer.googleapis.com"\n',
      }),
    ).toEqual([
      "endpoint-default@common/lib/constants.ts:2",
      "endpoint@lm_eval/tasks/realtoxicityprompts/metric.py:1",
      "client-package@package.json:3",
      "google-client@src/helm/clients/perspective_api_client.py:4",
    ]);
  });

  it("dates the finding against the shutdown and links the notice", () => {
    const [f] = check(repoOf({ "a.py": 'u = "https://commentanalyzer.googleapis.com"\n' }), "2026-12-05").findings;
    expect(f!.message).toContain("stops after 2026-12-31 (26 days left)");
    expect(f!.sourceUrl).toBe("https://perspectiveapi.com/");
    expect(f!.fix).not.toMatch(/https?:\/\//);
  });

  it("runs only on repos that mention the API", async () => {
    const quiet = await runChecks(repoOf({ "a.py": "print('hi')\n" }), "2026-11-14", ["perspective"]);
    expect(quiet.notUsed.map((n) => n.id)).toEqual(["perspective"]);
    const loud = await runChecks(repoOf({ "a.rb": 'GOOGLE_API_DOMAIN = "https://commentanalyzer.googleapis.com"\n' }), "2026-11-14", ["perspective"]);
    expect(loud.checkers[0]!.findings).toHaveLength(1);
  });

  it("reads Perspective clients in Ruby, PHP and Go", () => {
    const tree = ["lib/discourse_perspective.rb", "src/Service/PerspectiveApiService.php", "internal/perspective/client.go", "lib/other.rb"].map((path) => ({ path, size: 10 }));
    expect(planReads(tree).read.map((e) => e.path).sort()).toEqual([
      "internal/perspective/client.go",
      "lib/discourse_perspective.rb",
      "src/Service/PerspectiveApiService.php",
    ]);
  });
});

describe("perspective read plan and gate (review)", () => {
  it("reads Gemfile, composer.json and requirements-*.in, so the package rules can fire", () => {
    const tree = ["Gemfile", "composer.json", "requirements-dev.in"].map((path) => ({ path, size: 10 }));
    expect(planReads(tree).read.map((e) => e.path).sort()).toEqual(["Gemfile", "composer.json", "requirements-dev.in"]);
  });

  it("doesn't push other source out of the 90-file budget for a folder named perspective", () => {
    const tree = [
      ...Array.from({ length: 120 }, (_, i) => ({ path: `packages/perspective/src/m${i}.ts`, size: 10 })),
      { path: "src/app/page.ts", size: 10 },
    ];
    expect(planReads(tree).read.map((e) => e.path)).toContain("src/app/page.ts");
  });

  it("runs on a repo whose only signal is a Poetry or PEP 621 dependency", async () => {
    for (const files of [
      { "pyproject.toml": '[tool.poetry.dependencies]\nperspective = "^1.0"\n' },
      { "pyproject.toml": 'dependencies = [\n  "perspective>=1.0",\n]\n' },
    ]) {
      const report = await runChecks(repoOf(files), "2026-11-14", ["perspective"]);
      expect(report.checkers[0]?.findings.map((f) => f.rule)).toEqual(["client-package"]);
    }
  });
});
