import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";
import { defaultHumanFor } from "../src/domain/workflow-human-destination.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";

// Several named people: anything that needs "the person" without naming one reaches the default person (the selected,
// else the marked, else the only one), never whoever sorts first; with several and none chosen it says so.

const person = (entityId: string, extra: Partial<HumanFragment> = {}): HumanFragment => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
  prefs: { deliveryClass: "B", availability: "available" }, ...extra,
});

describe("defaultHumanFor", () => {
  it("prefers the selected person, then the marked default, then the only person; several and none chosen is null", () => {
    const ana = person("ana"), mike = person("mike", { default: true });
    expect(defaultHumanFor([ana, mike], () => "ana@external")?.entityId).toBe("ana");
    expect(defaultHumanFor([ana, mike], () => "")?.entityId).toBe("mike");
    expect(defaultHumanFor([ana], () => "")?.entityId).toBe("ana");
    expect(defaultHumanFor([ana, person("bo")], () => "")).toBeNull();
    expect(defaultHumanFor([ana, mike], () => { throw new Error("settings unreadable"); })?.entityId).toBe("mike");
  });
});

describe("the wake ladder's person rung with several people", () => {
  let home: string;
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rig-named-default-"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const escalate = async (entities: HumanFragment[]) => {
    const refs: string[] = [];
    const registry: LoadResult = { ok: true, entities };
    const engine = makeOperatorDeliveryEngine({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry },
      dispatch: (_op, ref) => { refs.push(ref); return { ok: true, decisionId: `d${refs.length}` }; } });
    const row = await repo.create({ sourceSession: "lead@rig", destinationSession: "worker@rig", body: "stuck work", summary: "stuck", nudge: false });
    return { result: await engine.dispatchEscalation(row, "blocked"), refs };
  };

  it("escalates to the marked default person, not the first registered file", async () => {
    // "ana" sorts first; "mike" is the default.
    const { result, refs } = await escalate([person("ana"), person("mike", { default: true })]);
    expect(result).toMatchObject({ dispatched: true });
    expect(refs).toEqual(["mike@external"]);
  });

  it("with several people and none chosen, it's undeliverable and says why, and nothing is sent", async () => {
    const { result, refs } = await escalate([person("ana"), person("mike")]);
    expect(result).toMatchObject({ decision: "undeliverable:no-default-human", dispatched: false, resolved: false });
    expect(refs).toEqual([]);
  });
});
