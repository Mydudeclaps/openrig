import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";

// Two named people: when one answers, approves or resolves what was asked of the other, it's kept as their
// correspondence, in their own name, and the ask stays the asked person's to answer. Agents keep today's behaviour.

const person = (entityId: string): HumanFragment => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
  prefs: { deliveryClass: "B", availability: "available" },
});
const ANA = "human-ana@external";
const MIKE = "human-mike@external";
const QUESTIONS = [{ id: "q1", question: "Which name?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }];

describe("one person acting on another person's ask is correspondence", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let contract: MissionControlWriteContract;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const registry: LoadResult = { ok: true, entities: [person("human-ana"), person("human-mike")] };
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry });
    contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  });
  afterEach(() => db.close());

  const askAna = (extra: { humanQuestions?: typeof QUESTIONS } = {}) => repo.create({ sourceSession: "orch-lead@r",
    destinationSession: ANA, body: "Which name ships?", summary: "Name", evidenceRef: "/proof/name.md", nudge: false, ...extra });
  const replies = (row: QueueItem) => repo.list({ limit: 500 }).filter((q) => q.replyTo === row.qitemId);
  const lastNote = (row: QueueItem) => repo.listTransitions(row.qitemId).at(-1);
  const resolutions = (row: QueueItem) => repo.listTransitions(row.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved");

  it("an answer in another person's words is kept in their name, and the asked person still answers it", async () => {
    const ask = await askAna();
    const result = await contract.act({ verb: "answer", qitemId: ask.qitemId, actorSession: MIKE, decision: "Beta, I think" });

    expect(result.correspondence).toEqual({ askedPerson: ANA, message: expect.stringContaining(`not as ${ANA}'s answer`) });
    expect(result.correspondence?.message).toContain("nothing was answered, closed or unparked");
    expect(repo.getById(ask.qitemId)).toMatchObject({ state: "pending", humanAnswers: null });
    expect(lastNote(ask)).toMatchObject({ actorSession: MIKE, state: "pending",
      transitionNote: `Correspondence from ${MIKE}, not ${ANA}'s answer: Beta, I think` });
    expect(replies(ask)).toEqual([]);
    expect(resolutions(ask)).toEqual([]);

    // Ana's own answer completes it as usual: one reply in her name, and the ask closes.
    expect(await contract.act({ verb: "answer", qitemId: ask.qitemId, actorSession: ANA, decision: "Alpha" }))
      .toMatchObject({ answer: { outcome: "answered" } });
    expect(repo.getById(ask.qitemId)?.state).toBe("done");
    expect(replies(ask).map((r) => r.sourceSession)).toEqual([ANA]);
  });

  it("another person's choice is kept as words, never as the ask's answers", async () => {
    const ask = await askAna({ humanQuestions: QUESTIONS });
    const result = await contract.act({ verb: "answer", qitemId: ask.qitemId, actorSession: MIKE, questionId: "q1", optionId: "b" });

    expect(result.correspondence?.askedPerson).toBe(ANA);
    expect(lastNote(ask)?.transitionNote).toBe(`Correspondence from ${MIKE}, not ${ANA}'s answer: Which name?: Beta`);
    expect(repo.getById(ask.qitemId)?.humanAnswers ?? {}).toEqual({});
    expect(await contract.act({ verb: "answer", qitemId: ask.qitemId, actorSession: ANA, questionId: "q1", optionId: "a" }))
      .toMatchObject({ answer: { outcome: "answered" } });
    expect(repo.getById(ask.qitemId)).toMatchObject({ state: "done", humanAnswers: { q1: "a" } });
  });

  it("another person's approve leaves the ask open for the asked person", async () => {
    const ask = await askAna();
    const result = await contract.act({ verb: "approve", qitemId: ask.qitemId, actorSession: MIKE, reason: "looks fine" });

    expect(result.correspondence?.askedPerson).toBe(ANA);
    expect(repo.getById(ask.qitemId)?.state).toBe("pending");
    expect(lastNote(ask)?.transitionNote).toBe(`Correspondence from ${MIKE}, not ${ANA}'s answer: approved: looks fine`);
    await contract.act({ verb: "approve", qitemId: ask.qitemId, actorSession: ANA });
    expect(repo.getById(ask.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("another person's resolve leaves a parked question parked on its person", async () => {
    const parked = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "dev@r", body: "work", nudge: false });
    repo.update({ qitemId: parked.qitemId, actorSession: "dev@r", state: "blocked", blockedOn: "human-ana@host", summary: "Parked",
      evidenceRef: "/proof/parked.md", transitionNote: "parked on Ana" });

    const result = await contract.act({ verb: "resolve", qitemId: parked.qitemId, actorSession: MIKE, decision: "go ahead", notify: false });
    expect(result.correspondence?.message).toContain("is still parked on human-ana@external");
    expect(repo.getById(parked.qitemId)).toMatchObject({ state: "blocked", blockedOn: "human-ana@host" });
    expect(lastNote(parked)).toMatchObject({ actorSession: MIKE, transitionNote: `Correspondence from ${MIKE}, not ${ANA}'s answer: go ahead` });
    expect(resolutions(parked)).toEqual([]);

    await contract.act({ verb: "resolve", qitemId: parked.qitemId, actorSession: ANA, decision: "go ahead", notify: false });
    expect(repo.getById(parked.qitemId)?.state).toBe("in-progress");
    expect(resolutions(parked).map((t) => t.actorSession)).toEqual([ANA]);
  });

  it("a different person's Slack reply to a parked question doesn't resume it", async () => {
    const parked = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "dev@r", body: "work", nudge: false });
    repo.update({ qitemId: parked.qitemId, actorSession: "dev@r", state: "blocked", blockedOn: "human-ana@host", summary: "Parked",
      evidenceRef: "/proof/parked.md", transitionNote: "parked on Ana" });
    const before = repo.listTransitions(parked.qitemId).length;

    expect(await makeHumanReplyResolver(repo, contract)({ qitemId: parked.qitemId, actorSession: MIKE, decision: "go ahead" }))
      .toBe("not-applicable");
    expect(repo.getById(parked.qitemId)?.state).toBe("blocked");
    expect(repo.listTransitions(parked.qitemId)).toHaveLength(before);
  });

  it("agents keep today's behaviour: an agent can't answer a person's ask, and its approve still closes", async () => {
    const ask = await askAna();
    await expect(contract.act({ verb: "answer", qitemId: ask.qitemId, actorSession: "orch-lead@r", decision: "x" }))
      .rejects.toMatchObject({ code: "answer_not_recorded" });
    const result = await contract.act({ verb: "approve", qitemId: ask.qitemId, actorSession: "orch-lead@r" });
    expect(result.correspondence).toBeUndefined();
    expect(repo.getById(ask.qitemId)?.state).toBe("done");
  });
});
