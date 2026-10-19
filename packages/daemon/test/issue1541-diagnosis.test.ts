// Bounded diagnosis only: reported menu text, modeled pane/process reads, no native Claude or approval input.
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { transportRoutes } from "../src/routes/transport.js";

const oldMenu = `  2 new MCP servers found in .mcp.json
  Select any you wish to enable.

  MCP servers may execute code or access system resources. All tool calls
  require approval. Learn more in the MCP documentation.

  ❯ [✔] dummy1
    [✔] dummy2
 Space to select · Enter to confirm · Esc to reject all`;
const newMenu = oldMenu.replace("in .mcp.json", "in this project")
  .replace(" Space to select · Enter to confirm · Esc to reject all", "       Enable selected\n Space to select · Esc to reject all");
const rule = "─".repeat(60);
const composer = `Claude Code v2.1.303\n${rule}\n❯ \n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
const frames = [
  { id: "old-current-MCP", pane: oldMenu },
  { id: "2.1.303-current-MCP", pane: newMenu },
  { id: "genuine-composer", pane: composer },
  { id: "old-MCP-history-before-composer", pane: `${oldMenu}\n\n${composer}` },
  { id: "new-MCP-history-before-composer", pane: `${newMenu}\n\n${composer}` },
  { id: "ordinary-current-permission", pane: "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to cancel" },
  { id: "MCP-prose-before-composer", pane: `The project has new MCP servers. Select any you wish to enable.\n\n${composer}` },
  { id: "clipped-new-MCP", pane: newMenu.split("\n").slice(0, 3).join("\n") },
  { id: "current-checkbox-cursor-without-normal-composer", pane: "Choose\n❯ [✔] option\nSpace to select · Esc to reject all" },
];
const cleanup: Array<() => void | Promise<void>> = [];
const records: unknown[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
afterAll(() => {
  const dir = process.env.CHECKPOINT_OUTPUT;
  if (!dir) throw new Error("diagnostic output required");
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "observations.json"), JSON.stringify(records, null, 2) + "\n");
});

describe("1541 actual assessment, checkReady and HTTP send observations", () => {
  it.each(frames)("$id", async frame => {
    const db = new Database(":memory:"); cleanup.push(() => db.close()); migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('node','rig','worker','claude-code');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('binding','node','worker@test','%1');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('session','node','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('generation','node',1,'g1','fresh');`);
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); guard.recoverActivation();
    let staged = "", command = "claude";
    const effects: Array<{ kind: string; argv: string[]; text?: string }> = [];
    const tmux = new TmuxAdapter(async () => "", {
      writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/input", bufferName: () => "input",
    }, async argv => {
      if (argv[1] === "paste-buffer") effects.push({ kind: "paste", argv: [...argv], text: staged });
      if (argv[1] === "send-keys") effects.push({ kind: "keys", argv: [...argv] });
      return "";
    });
    tmux.deliveryGuard = guard;
    vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
    vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
    vi.spyOn(tmux, "getPaneCommand").mockImplementation(async () => command);
    vi.spyOn(tmux, "getPanePid").mockResolvedValue(null);
    vi.spyOn(tmux, "capturePaneContent").mockResolvedValue(frame.pane);
    const fsError = () => { throw new Error("unexpected filesystem effect"); };
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: {
      exists: () => false, readFile: fsError, writeFile: fsError, mkdirp: fsError, copyFile: fsError,
    }, listProcesses: () => [], sleep: async () => {} });
    const binding = { id: "binding", nodeId: "node", tmuxSession: "worker@test", tmuxWindow: null, tmuxPane: "%1",
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture" };
    const assessments = [
      { paneCommand: "bash", verified: false }, { paneCommand: "bash", verified: true }, { paneCommand: "claude", verified: false },
    ].map(input => ({ ...input, result: assessNativeResumeProbe({ runtime: "claude-code", paneContent: frame.pane,
      paneCommand: input.paneCommand, ...(input.verified ? { claudeResumeIdentityVerified: true } : {}) }) }));
    const readiness: unknown[] = [];
    for (const paneCommand of ["bash", "claude"]) { command = paneCommand; readiness.push({ paneCommand, result: await adapter.checkReady(binding) }); }
    command = "claude";
    const now = new Date("2026-10-19T19:30:00Z");
    const eventBus = new EventBus(db), activity = new AgentActivityStore({ db, eventBus });
    const transport = new SessionTransport({ db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      eventBus, agentActivityStore: activity, now: () => now, sleep: async () => {} });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport); await next(); });
    app.route("/api/transport", transportRoutes());
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const sends: unknown[] = [];
    for (const hook of ["none", "running", "permission"] as const) {
      if (hook !== "none") activity.recordHookEvent({ runtime: "claude-code", sessionName: "worker@test",
        hookEvent: hook === "running" ? "UserPromptSubmit" : "Notification", ...(hook === "permission" ? { subtype: "permission_prompt" } : {}), occurredAt: now.toISOString() });
      effects.length = 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/transport/send`, { method: "POST",
        headers: { "content-type": "application/json", "x-openrig-session": "sender@test" },
        body: JSON.stringify({ session: "worker@test", text: "ordinary status update" }) });
      const body = await response.json();
      sends.push({ hook, status: response.status, body, effects: structuredClone(effects) });
      expect(response.status).toBe(body.ok ? 200 : 409);
      expect(effects.map(x => x.kind)).toEqual(body.ok ? ["paste", "keys"] : []);
      if (hook === "permission") expect(body).toMatchObject({ ok: false, reason: "target_needs_input" });
      if (frame.id === "2.1.303-current-MCP" && hook === "none") expect(body.ok).toBe(true); // Reproduced defect, NOT desired safety behavior.
    }
    if (frame.id === "old-current-MCP") expect(assessments[0]!.result).toMatchObject({ status: "inconclusive", code: "mcp_gate" });
    if (frame.id === "2.1.303-current-MCP") expect(assessments[1]!.result).toMatchObject({ status: "resumed", code: "verified_native_identity" });
    records.push({ id: frame.id, pane: frame.pane, assessments, readiness, classifier: classifyPaneActivity(frame.pane, { runtime: "claude-code" }), sends });
  });
});
