// The Feed's perspective: whose queue it shows. Viewing a colleague's queue is a view, never an identity: whatever is shown,
// acts on it carry the primary user's authority, the person at the terminal. Real SQLite (all migrations), the real queue
// and the real attention route. Native: NOT RUN.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { LoadResult } from "../src/domain/gateway/human-registry.js";
import { attentionRoutes } from "../src/routes/attention.js";
import type { AttentionRead } from "../src/attention-surface.js";

const person = (entityId: string) => ({
  entityId, class: "human" as const, displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: `U${entityId}` }],
  prefs: { deliveryClass: "B" as const, availability: "available" as const },
});

describe("the Feed shows one person's queue, or everyone's, and acts with the primary user's authority whichever it shows", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let registry: LoadResult;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    registry = { ok: true, entities: [person("mike"), person("sarah")] };
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => registry });
  });
  afterEach(() => { db.close(); });

  const askTo = (destinationSession: string, summary: string) =>
    repo.create({ sourceSession: "orch-lead@r", destinationSession, body: `${summary} body`, summary, nudge: false });
  async function read(query = ""): Promise<AttentionRead> {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); await next(); });
    app.route("/api/attention", attentionRoutes());
    return await (await app.request(`/api/attention${query}`)).json() as AttentionRead;
  }
  const asked = (r: AttentionRead) => r.items.filter((i) => i.id.startsWith("queue:")).map((i) => i.summary).sort();

  it("with no view it shows every person's asks, as before, and says who acts", async () => {
    await askTo("mike@external", "Mike's ask");
    await askTo("sarah@external", "Sarah's ask");
    const all = await read();
    expect(asked(all)).toEqual(["Mike's ask", "Sarah's ask"]);
    // Two people and no default: the primary user acts, unnamed.
    expect(all.perspective).toEqual({ viewing: null, basis: "all", actingAs: { person: null, authority: "primary-user" } });
  });

  it("viewing one person shows only their asks, and doesn't change who acts or how", async () => {
    const mike = await askTo("mike@external", "Mike's ask");
    const sarah = await askTo("sarah@external", "Sarah's ask");
    const all = await read();
    for (const view of ["sarah", "sarah@external"]) {
      const r = await read(`?view=${encodeURIComponent(view)}`);
      expect(asked(r)).toEqual(["Sarah's ask"]);
      expect(r.perspective).toEqual({ viewing: "sarah@external", basis: "chosen-here", actingAs: { person: null, authority: "primary-user" } });
      // The act on Sarah's ask is the same one the unfiltered Feed offers: the view is not an identity.
      expect(r.items.find((i) => i.id === `queue:${sarah.qitemId}`)).toEqual(all.items.find((i) => i.id === `queue:${sarah.qitemId}`));
    }
    // An item opened by id is still shown in full, whichever queue is viewed.
    const opened = await read(`?view=sarah&item=${encodeURIComponent(`queue:${mike.qitemId}`)}`);
    expect(opened.detail?.item.id).toBe(`queue:${mike.qitemId}`);
    expect(asked(await read("?view=all"))).toEqual(["Mike's ask", "Sarah's ask"]);
  });

  it("with one person, the default view is theirs and they're the primary user", async () => {
    registry = { ok: true, entities: [person("mike")] };
    await askTo("mike@external", "Mike's ask");
    const r = await read("?view=default");
    expect(asked(r)).toEqual(["Mike's ask"]);
    expect(r.perspective).toEqual({ viewing: "mike@external", basis: "default", actingAs: { person: "mike@external", authority: "primary-user" } });
  });

  it("with several people and no default, the default view is everyone's, and says so", async () => {
    await askTo("mike@external", "Mike's ask");
    await askTo("sarah@external", "Sarah's ask");
    const r = await read("?view=default");
    expect(asked(r)).toEqual(["Mike's ask", "Sarah's ask"]);
    expect(r.perspective).toMatchObject({ viewing: null, basis: "all" });
  });

  it("a view naming no registered person shows no one's asks, and names what was asked for", async () => {
    await askTo("mike@external", "Mike's ask");
    const r = await read("?view=ana");
    expect(asked(r)).toEqual([]);
    expect(r.perspective).toEqual({ viewing: null, basis: "unknown", requested: "ana", actingAs: { person: null, authority: "primary-user" } });
  });

  it("with no registered person there is no perspective, and the Feed is as before", async () => {
    registry = { ok: true, entities: [] };
    await askTo("human@host", "A seat's ask");
    const r = await read("?view=default");
    expect(r.perspective).toBeUndefined();
    expect(asked(r)).toEqual(["A seat's ask"]);
  });
});
