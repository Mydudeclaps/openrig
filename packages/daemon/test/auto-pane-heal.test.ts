import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// Legacy launchers left the window/pane NULL. Use the real send/guard/adapter
// with private SQLite and inert terminal effects; no provider is started.
function fixture(kind: "050" | "046" = "050") {
  const db = createFullTestDb(); databases.push(db);
  const rigRepo = new RigRepository(db), sessions = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("legacy-fixture");
  const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
  const original = sessions.registerSession(node.id, "worker@legacy-fixture");
  sessions.updateStatus(original.id, "running");
  sessions.updateResumeToken(original.id, "codex_id", "retained-native-id", "hook");
  let current = original;
  if (kind === "046") {
    // A reconciled legacy seat has superseded history and a current claimed row.
    sessions.updateStatus(original.id, "superseded");
    const prior = sessions.registerClaimedSession(node.id, original.sessionName);
    sessions.updateStatus(prior.id, "superseded");
    current = sessions.registerClaimedSession(node.id, original.sessionName);
    sessions.updateResumeToken(current.id, "claude_id", "retained-claimed-id", "hook");
  }
  sessions.updateBinding(node.id, { tmuxSession: current.sessionName });
  db.prepare("DELETE FROM occupant_tenures WHERE node_id=?").run(node.id);
  db.prepare("UPDATE sessions SET restore_policy=? WHERE node_id=?").run(kind === "050" ? "relaunch_fresh" : "resume_if_possible", node.id);
  db.prepare("UPDATE bindings SET updated_at='2000-01-01' WHERE node_id=?").run(node.id);
  const commands: string[] = [], bodies: string[] = [];
  const tmux = new TmuxAdapter(async command => { commands.push(command); return ""; }, {
    writeFile: async (_path, body) => { bodies.push(body); }, unlink: async () => {}, tmpName: () => "/inert/payload", bufferName: () => "fixture",
  });
  tmux.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  tmux.probeSession = vi.fn(async () => ({ state: "present" as const }));
  tmux.hasSession = vi.fn(async () => true);
  tmux.listSessions = vi.fn(async () => [{ name: current.sessionName, windows: 1, created: "123", attached: false }]);
  tmux.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/inert", width: 80, height: 24, active: true }]);
  tmux.getPanePid = vi.fn(async () => 4242);
  tmux.getPaneCommand = vi.fn(async () => "claude");
  const transport = new SessionTransport({ db, rigRepo, sessionRegistry: sessions, tmuxAdapter: tmux, eventBus, sleep: async () => {} });
  return { db, node, current, tmux, transport, commands, bodies, outbox: new OutboxHandler(db) };
}
function state(f: ReturnType<typeof fixture>) {
  return { sessions: f.db.prepare("SELECT * FROM sessions ORDER BY id").all(), tenures: f.db.prepare("SELECT * FROM occupant_tenures").all(),
    bindings: f.db.prepare("SELECT * FROM bindings").all() as Array<Record<string, unknown>> };
}

describe("managed send fills only a missing legacy pane", () => {
  it.each(["050", "046"] as const)("heals and sends once for %s legacy records without adoption", async kind => {
    const f = fixture(kind), before = state(f);
    const result = await f.transport.send(f.current.sessionName, "NEW message", { force: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const after = state(f);
    expect(after.sessions).toEqual(before.sessions); expect(after.tenures).toEqual(before.tenures);
    expect(after.bindings).toEqual(before.bindings.map(row => ({ ...row, tmux_pane: "%1", updated_at: expect.any(String) })));
    expect(f.bodies).toEqual(["NEW message"]);
    expect(f.commands.filter(c => c.includes("paste-buffer"))).toHaveLength(1);
    expect(f.commands.filter(c => c.includes("send-keys"))).toHaveLength(1);
    expect(f.tmux.probeSession).toHaveBeenCalledTimes(2);
    expect(f.tmux.listSessions).toHaveBeenCalledTimes(2);
    expect(f.commands.some(c => /new-session|kill-session|respawn|pipe-pane/.test(c))).toBe(false);
  });

  it.each(["two panes", "two windows", "changed pid", "changed pane", "changed session", "replacement", "missing session", "unavailable"])("leaves input and metadata alone on %s", async mode => {
    const f = fixture();
    if (mode === "two panes") vi.mocked(f.tmux.listPanes).mockResolvedValue([{ id: "%1" }, { id: "%2" }] as never);
    if (mode === "two windows") vi.mocked(f.tmux.listSessions).mockResolvedValue([{ name: f.current.sessionName, windows: 2, created: "123" }] as never);
    if (mode === "changed pid") vi.mocked(f.tmux.getPanePid).mockResolvedValueOnce(4242).mockResolvedValue(4243);
    if (mode === "changed pane") vi.mocked(f.tmux.listPanes).mockResolvedValueOnce([{ id: "%1" }] as never).mockResolvedValue([{ id: "%2" }] as never);
    if (mode === "changed session") vi.mocked(f.tmux.listSessions).mockResolvedValueOnce([{ name: f.current.sessionName, windows: 1, created: "123" }] as never).mockResolvedValue([{ name: f.current.sessionName, windows: 1, created: "124" }] as never);
    if (mode === "replacement") vi.mocked(f.tmux.getPanePid).mockImplementation(async () => { f.db.prepare("UPDATE sessions SET status='exited' WHERE id=?").run(f.current.id); return 4242; });
    if (mode === "missing session") vi.mocked(f.tmux.probeSession).mockResolvedValue({ state: "absent" });
    if (mode === "unavailable") vi.mocked(f.tmux.probeSession).mockResolvedValue({ state: "transport_unavailable", cause: "fixture" });
    const before = state(f);
    const result = await f.transport.send(f.current.sessionName, "MUST NOT WRITE", { force: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--repair-missing-pane --no-launch");
    expect(state(f).bindings).toEqual(before.bindings);
    expect(f.bodies).toEqual([]); expect(f.commands.some(c => /paste-buffer|send-keys/.test(c))).toBe(false);
  });

  it("does not replace a recorded pane or reinterpret a retained delivery", async () => {
    const f = fixture();
    f.outbox.retain({ outboxId: "held", senderSession: "sender", destinationSession: f.current.sessionName, body: "OLD" }, f.tmux.deliveryGuard!.target(f.current.sessionName));
    expect(await f.transport.send(f.current.sessionName, "OLD", { deliveryId: "held", actorSession: "sender" })).toMatchObject({ outcome: "retained", sent: false });
    expect(f.tmux.listSessions).not.toHaveBeenCalled();
    expect((await f.transport.send(f.current.sessionName, "NEW", { force: true })).ok).toBe(true);
    const after = state(f);
    expect(await f.transport.send(f.current.sessionName, "OLD", { committedOutboxIds: ["held"] })).toMatchObject({ ok: false, reason: "guard_target_changed" });
    vi.mocked(f.tmux.listPanes).mockResolvedValue([{ id: "%2" }] as never);
    expect((await f.transport.send(f.current.sessionName, "WRONG PANE", { force: true })).ok).toBe(false);
    expect(state(f)).toEqual(after); expect(f.bodies).toEqual(["NEW"]);
  });

  it("heals a new committed queue wake and keeps its frozen identity", async () => {
    const f = fixture();
    f.outbox.record({ outboxId: "wake", senderSession: "sender", destinationSession: f.current.sessionName, body: "NEW WAKE" });
    const binding = f.tmux.deliveryGuard!.target(f.current.sessionName);
    f.db.prepare("UPDATE outbox_entries SET guard_binding=? WHERE outbox_id='wake'").run(JSON.stringify(binding));
    expect((await f.transport.send(f.current.sessionName, "NEW WAKE", { force: true, committedOutboxIds: ["wake"], actorSession: "sender" })).ok).toBe(true);
    expect(f.outbox.getById("wake")!.guardBinding).toEqual(binding);
    expect(f.bodies).toEqual(["NEW WAKE"]);
  });
});
