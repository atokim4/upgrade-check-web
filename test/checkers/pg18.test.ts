import { describe, expect, it } from "vitest";
import { check } from "../../src/checkers/pg18.ts";
import { repoOf } from "../helpers/repo.ts";

const found = (files: Record<string, string>, today = "2026-11-13") => check(repoOf(files), today).findings.map((f) => `${f.rule}@${f.file}:${f.line}`);

const compose = (image: string, mount: string) =>
  `services:\n  db:\n    image: ${image}\n    environment:\n      POSTGRES_PASSWORD: example\n    volumes:\n      - pgdata:${mount}\nvolumes:\n  pgdata:\n`;

describe("pg18 checker", () => {
  it("finds the old data mount on a postgres:18 image", () => {
    const report = check(repoOf({ "docker-compose.yml": compose("postgres:18", "/var/lib/postgresql/data") }), "2026-11-13");
    expect(report.findings.map((f) => `${f.rule}@${f.file}:${f.line}:${f.severity}`)).toEqual(["data-mount@docker-compose.yml:7:error"]);
    expect(report.findings[0]!.message).toMatch(/^db: postgres:18 keeps its data in \/var\/lib\/postgresql\/18\/docker/);
    expect(report.findings[0]!.fix).toMatch(/Keep the old layout/);
  });

  it("finds a floating tag on a volume, and a major past its final release", () => {
    expect(found({ "compose.yaml": compose("postgres", "/var/lib/postgresql/data") })).toContain("floating-tag@compose.yaml:3");
    expect(found({ "compose.yaml": compose("postgres:14-alpine", "/var/lib/postgresql/data") })).toEqual(["eol-major@compose.yaml:3"]);
    expect(found({ "compose.yaml": compose("postgres:14-alpine", "/var/lib/postgresql/data") }, "2026-11-11")).toEqual([]);
    expect(found({ "compose.yaml": compose("postgres:9.6", "/var/lib/postgresql/data") })).toEqual(["eol-major@compose.yaml:3"]);
  });

  it("has no false positives on a correct 18 setup, 16/17 images, CI services and other databases", () => {
    expect(
      found({
        "docker-compose.yml": compose("postgres:18-alpine", "/var/lib/postgresql"),
        "dev/compose.yml": compose("postgres:17", "/var/lib/postgresql/data"),
        ".github/workflows/ci.yml": "jobs:\n  test:\n    services:\n      postgres:\n        image: postgres:18\n        ports: ['5432:5432']\n",
        "mysql/compose.yml": "services:\n  db:\n    image: mysql:8\n    volumes:\n      - d:/var/lib/mysql\n",
      }),
    ).toEqual([]);
  });

  it("reads PGDATA from the compose file", () => {
    const text = compose("postgres:18", "/var/lib/postgresql/data").replace("POSTGRES_PASSWORD: example", "POSTGRES_PASSWORD: example\n      PGDATA: /var/lib/postgresql/data/pgdata");
    expect(found({ "docker-compose.yml": text })).toEqual([]);
  });
});
