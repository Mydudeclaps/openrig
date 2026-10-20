// Real repositories/services/routes; tmux and runtime effects are inert recorders.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { transportRoutes } from "../src/routes/transport.js";

describe("attached team address preserves physical custody", () => {
  let db: ReturnType<typeof createDb>, rigs: RigRepository, pods: PodRepository, sessions: SessionRegistry, bus: EventBus;
  let attach: SelfAttachService, transport: SessionTransport, tmux: TmuxAdapter, app: Hono;
  let writes: Array<{ target: string; text: string }>;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db); pods = new PodRepository(db); sessions = new SessionRegistry(db); bus = new EventBus(db);
    writes = [];
    tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" }),
      capturePaneContent: async () => "plain terminal", getPaneCommand: async () => "sh",
      sendText: async (target: string, text: string) => { writes.push({ target, text }); return { ok: true }; },
      sendKeys: async () => ({ ok: true }), createSession: vi.fn(async () => ({ ok: false, code: "session_exists", message: "inert" })),
    } as unknown as TmuxAdapter;
    attach = new SelfAttachService({ db, rigRepo: rigs, podRepo: pods, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
    transport = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: sessions, tmuxAdapter: tmux, sleep: async () => {} });
    app = new Hono(); app.use("*", async (c, next) => { c.set("selfAttachService" as never, attach); c.set("sessionTransport" as never, transport); await next(); });
    app.route("/api/rigs", rigsRoutes); app.route("/api/transport", transportRoutes());
  });
  afterEach(() => db.close());
  const context = (tmuxSession: string) => ({ attachmentType: "tmux" as const, tmuxSession, tmuxWindow: "@12", tmuxPane: "%42" });

  it.each(["0", "person-terminal"])("returns a routable sender and records the display label without renaming %s", async (physical) => {
    const rig = rigs.createRig("sample-team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    const result = await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, displayName: "Taylor", context: context(physical) });
    expect(result).toMatchObject({ ok: true, sessionName: physical, senderAddress: "person-agent@sample-team", env: { OPENRIG_SESSION_NAME: "person-agent@sample-team" } });
    expect(rigs.getRig(rig.id)?.nodes[0]?.label).toBe("Taylor");
    expect(sessions.getBindingForNode(node.id)).toMatchObject({ tmuxSession: physical, tmuxPane: "%42" });
    expect(sessions.getSessionsForRig(rig.id)[0]?.sessionName).toBe(physical);
    if (!result.ok) throw new Error("attach failed");
    const response = await app.request("/api/transport/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: result.env.OPENRIG_SESSION_NAME, text: "harmless reply" }) });
    expect(response.status).toBe(200); expect((await response.json()).ok).toBe(true);
    expect(writes).toEqual([{ target: physical, text: "harmless reply" }]);
    const raw = await transport.send(physical, "raw reply"); expect(raw.ok).toBe(true);
    expect(writes.at(-1)).toEqual({ target: physical, text: "raw reply" });
  });

  it("refuses an ambiguous flattened member before binding or provisioning", async () => {
    const rig = rigs.createRig("team"), first = rigs.addNode(rig.id, "p.a-b", { runtime: "terminal" });
    expect((await attach.attachToNode({ rigId: rig.id, logicalId: first.logicalId, context: context("first") })).ok).toBe(true);
    const second = rigs.addNode(rig.id, "p-a.b", { runtime: "terminal" });
    const before = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    const result = await attach.attachToNode({ rigId: rig.id, logicalId: second.logicalId, context: context("second") });
    expect(result).toMatchObject({ ok: false, code: "address_conflict" });
    if (!result.ok) expect(result.error).toMatch(/another member name/i);
    expect(sessions.getBindingForNode(second.id)).toBeNull();
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before);
  });

  it("refuses a new physical name that would steal another member's advertised address", async () => {
    const rig = rigs.createRig("team"), first = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: first.logicalId, context: context("0") });
    const second = rigs.addNode(rig.id, "other.agent", { runtime: "terminal" });
    expect(await attach.attachToNode({ rigId: rig.id, logicalId: second.logicalId, context: context("person-agent@team") })).toMatchObject({ ok: false, code: "address_conflict" });
    expect(sessions.getBindingForNode(first.id)?.tmuxSession).toBe("0"); expect(sessions.getBindingForNode(second.id)).toBeNull();
  });

  it("later launch refuses the same address before creating any tmux session", async () => {
    const rig = rigs.createRig("team"), first = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: first.logicalId, context: context("0") });
    const second = rigs.addNode(rig.id, "other.agent", { runtime: "terminal" });
    const launcher = new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
    expect(await launcher.launchNode(rig.id, second.logicalId, { sessionName: "person-agent@team" })).toMatchObject({ ok: false, code: "address_conflict" });
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("logical and raw queue owners see and claim the same current rows without rewriting them", async () => {
    const rig = rigs.createRig("team"), node = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
    await attach.attachToNode({ rigId: rig.id, logicalId: node.logicalId, context: context("0") });
    const queue = new QueueRepository(db, bus, { resolveSessionAddresses: (name: string) => sessions.sessionAddresses(name) });
    const item = await queue.create({ sourceSession: "operator@team", destinationSession: "0", body: "work", nudge: false });
    expect(queue.list({ destinationSession: "person-agent@team" }).map((q) => q.qitemId)).toContain(item.qitemId);
    expect(queue.claim({ qitemId: item.qitemId, destinationSession: "person-agent@team" }).destinationSession).toBe("0");
    expect(queue.whoami("person-agent@team").asDestination.inProgress).toBe(1);
  });
});
