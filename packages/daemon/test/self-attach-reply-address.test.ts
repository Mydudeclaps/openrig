import { describe, expect, it, vi } from "vitest";
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
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { transportRoutes } from "../src/routes/transport.js";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";

describe("self-attach logical reply address", () => {
  it.each(["0", "person-terminal"])("routes the logical From address to the unchanged %s tmux binding", async (physicalSession) => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db);
      const podRepo = new PodRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const rig = rigRepo.createRig("sample-team");
      const node = rigRepo.addNode(rig.id, "person.agent", { runtime: "terminal" });
      const paneWrites: Array<{ target: string; pane: string; text: string }> = [];
      const sendText = vi.fn(async (target: string, text: string) => {
        if (target !== physicalSession) throw new Error("unexpected physical target");
        paneWrites.push({ target, pane: "%42", text });
        return { ok: true as const };
      });
      const tmux = {
        hasSession: async (name: string) => name === physicalSession,
        probeSession: async (name: string) => ({ state: name === physicalSession ? "present" : "absent" }),
        capturePaneContent: async () => "plain terminal",
        getPaneCommand: async () => "sh",
        sendText,
        sendKeys: vi.fn(async () => ({ ok: true as const })),
      } as unknown as TmuxAdapter;
      const service = new SelfAttachService({ db, rigRepo, podRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, sleep: async () => {} });
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("selfAttachService" as never, service);
        c.set("sessionTransport" as never, transport);
        await next();
      });
      app.route("/api/rigs", rigsRoutes);
      app.route("/api/transport", transportRoutes());
      const attach = await app.request(`/api/rigs/${rig.id}/attach-self`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logicalId: "person.agent", displayName: "Taylor", attachmentType: "tmux",
          tmuxSession: physicalSession, tmuxWindow: "@12", tmuxPane: "%42" }),
      });
      expect(attach.status).toBe(201);
      const attached = await attach.json();
      expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe(physicalSession);

      // The proposed logical identity is substituted only in the envelope here. No alias is installed.
      const proposedSender = "person-agent@sample-team";
      const envelope = wrapPaneEnvelope(proposedSender, "operator@sample-team", "hello");
      const from = envelope.split("\n")[0]!.slice("From: ".length);
      expect(envelope).toContain(`rig send ${from} "..."`);
      const send = (session: string) => app.request("/api/transport/send", {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "operator@sample-team" },
        body: JSON.stringify({ session, text: "harmless reply" }),
      });
      const logicalResolution = await transport.resolveSessions({ session: from });
      const logicalReply = await send(from);
      const logicalBody = await logicalReply.json();
      expect(paneWrites).toEqual([]);
      const physicalReply = await send(attached.env.OPENRIG_SESSION_NAME);
      const physicalBody = await physicalReply.json();
      expect(physicalReply.status).toBe(200);
      expect(physicalBody.ok).toBe(true);
      expect(paneWrites).toEqual([{ target: physicalSession, pane: "%42", text: "harmless reply" }]);
      console.info(JSON.stringify({ physicalSession, attachedName: attached.env.OPENRIG_SESSION_NAME,
        proposedFrom: from, logicalResolution, logicalStatus: logicalReply.status, logicalBody,
        physicalStatus: physicalReply.status, paneWrites }));
      // This is the required acceptance check: the exact logical From/reply address must reach this pane.
      expect(logicalReply.status).toBe(200);
    } finally {
      db.close();
    }
  });
});
