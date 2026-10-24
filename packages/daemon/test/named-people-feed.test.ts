import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { attentionRoutes } from "../src/routes/attention.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";
import type { AttentionRead } from "../src/attention-surface.js";

// The Feed answers as one person: the one chosen where it's read (rig tui --as), else the default person. It says so, and
// says it's a local choice; it offers answer acts only on that person's own asks, and shows everyone else's.

const person = (entityId: string, extra: Partial<HumanFragment> = {}): HumanFragment => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
  prefs: { deliveryClass: "B", availability: "available" }, ...extra,
});
const ANA = "human-ana@external";
const MIKE = "human-mike@external";

describe("the Feed answers as one named person", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let registry: LoadResult;
  let app: Hono;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    registry = { ok: true, entities: [person("human-ana", { default: true }), person("human-mike")] };
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry });
    const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo as never);
      c.set("eventBus" as never, bus as never);
      c.set("missionControlWriteContract" as never, writeContract as never);
      await next();
    });
    app.route("/api/attention", attentionRoutes());
    app.route("/api/mission-control", missionControlRoutes());
  });
  afterEach(() => db.close());

  const ask = (to: string) => repo.create({ sourceSession: "orch-lead@r", destinationSession: to, body: `for ${to}`,
    summary: `Ask ${to}`, evidenceRef: "/proof/ask.md", nudge: false });
  /** The TUI's own client and Feed model over this daemon, opened as `asPerson` (or the default person). */
  async function feed(asPerson?: string) {
    const { DaemonClient } = await import("../../tui/src/daemon-client.js");
    const { attentionLines } = await import("../../tui/src/attention/attention-model.js");
    const { createViewState, emptySnapshot } = await import("../../tui/src/state.js");
    const client = new DaemonClient({ baseUrl: "http://tui.test", asPerson,
      fetchImpl: ((input: string, init?: RequestInit) => app.request(String(input), init)) as typeof fetch });
    const read = await client.humanAttention() as AttentionRead;
    const text = attentionLines(createViewState({ instanceId: "fixture" }).get(), { ...emptySnapshot(), attentionRead: read }, 400)
      .map((l) => l.text).join("\n");
    const answerOn = (row: QueueItem) => read.items.find((i) => i.id === `queue:${row.qitemId}`)?.answer;
    return { client, read, text, answerOn };
  }

  it("by default it's the default person, answering their own asks and showing the other person's", async () => {
    const toAna = await ask(ANA), toMike = await ask(MIKE);
    const f = await feed();
    expect(f.read.viewer).toEqual({ person: ANA, basis: "default" });
    expect(f.text).toContain(`Answering as ${ANA}, the default person: a choice made in this terminal, not a verified identity.`);
    expect(f.answerOn(toAna)).toEqual({ verb: "approve", actorSession: ANA });
    expect(f.read.items.map((i) => i.id)).toContain(`queue:${toMike.qitemId}`);
    expect(f.answerOn(toMike)).toBeUndefined();
  });

  it("opened as another person, it answers their asks as them, and their approve closes their ask", async () => {
    const toAna = await ask(ANA), toMike = await ask(MIKE);
    const f = await feed("human-mike");
    expect(f.read.viewer).toEqual({ person: MIKE, basis: "chosen-here", chosen: "human-mike" });
    expect(f.text).toContain(`Answering as ${MIKE}, chosen with rig tui --as`);
    expect(f.answerOn(toAna)).toBeUndefined();
    expect(f.answerOn(toMike)).toEqual({ verb: "approve", actorSession: MIKE });
    await f.client.missionControlAction({ qitemId: toMike.qitemId, ...f.answerOn(toMike)! });
    expect(repo.getById(toMike.qitemId)?.state).toBe("done");
    expect(repo.getById(toAna.qitemId)?.state).toBe("pending");
  });

  it("a choice that names no registered person answers nothing, and says why", async () => {
    const toAna = await ask(ANA);
    const f = await feed("nobody");
    expect(f.read.viewer).toEqual({ person: null, basis: "none", chosen: "nobody" });
    expect(f.text).toContain("nobody isn't a registered person");
    expect(f.answerOn(toAna)).toBeUndefined();
  });

  it("several people and no default: nothing is answered as a guess, and it says how to choose", async () => {
    registry = { ok: true, entities: [person("human-ana"), person("human-mike")] };
    const toAna = await ask(ANA);
    const f = await feed();
    expect(f.read.viewer).toEqual({ person: null, basis: "none" });
    expect(f.text).toContain("Several people are registered and none is the default");
    expect(f.answerOn(toAna)).toBeUndefined();
  });
});
