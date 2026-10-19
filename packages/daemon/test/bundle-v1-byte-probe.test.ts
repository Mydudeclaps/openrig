import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";

it("captures a fixed-time ordinary v1 create archive", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-v1-"));
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS);
    fs.mkdirSync(path.join(root, "pkg/skills/demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "rig.yaml"), 'schema_version: 1\nname: ordinary-v1\nversion: "1.0"\nnodes:\n  - id: dev\n    runtime: claude-code\n    package_refs: ["./pkg"]\nedges: []\n', { mode: 0o644 });
    fs.writeFileSync(path.join(root, "pkg/package.yaml"), 'schema_version: 1\nname: pkg\nversion: "1.0.0"\nsummary: Fixture\ncompatibility:\n  runtimes: [claude-code]\nexports:\n  skills:\n    - source: skills/demo\n      name: demo\n      supported_scopes: [project_shared]\n      default_scope: project_shared\n', { mode: 0o644 });
    fs.writeFileSync(path.join(root, "pkg/skills/demo/SKILL.md"), "# Ordinary fixture\n", { mode: 0o644 });
    const archive = path.join(root, "ordinary.rigbundle");
    const res = await createTestApp(db).app.request("/api/bundles/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ specPath: path.join(root, "rig.yaml"), outputPath: archive, bundleName: "ordinary-v1", bundleVersion: "1.0" }) });
    const response = await res.json();
    expect(res.status, JSON.stringify(response)).toBe(201);
    const bytes = fs.readFileSync(archive);
    fs.copyFileSync(archive, process.env.BUNDLE_ARCHIVE_CAPTURE!);
    fs.writeFileSync(process.env.BUNDLE_ARCHIVE_CAPTURE! + ".json", JSON.stringify({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), response }, null, 2));
  } finally { db.close(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); }
});
