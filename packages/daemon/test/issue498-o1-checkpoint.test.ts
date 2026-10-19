// Bounded O1 checkpoint, not a native-runtime or cause-2 acceptance test.
// Real SessionTransport + SQLite hook store; captures/input effects are explicitly modeled.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

const idle = "Done.\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)";
const choice = "Choose a color\n❯ 1. RED\n  2. BLUE\nEnter to select";
const equalRender = "Earlier result\n❯ 1. Fix the bug\n  2. Explain it\n❯ \n⏵⏵ accept edits on";
const cases = [
  { id: "ordinary-idle", intent: "deliver", pane: idle },
  { id: "ordinary-working", intent: "deliver", pane: "Working on task...\n⠋ Processing\nesc to interrupt" },
  { id: "unknown", intent: "deliver", pane: "xyzzy no prompt here" },
  { id: "null-capture", intent: "deliver", pane: null },
  { id: "failed-capture", intent: "deliver", pane: idle, throws: true },
  { id: "current-choice", intent: "refuse", pane: choice },
  { id: "current-permission", intent: "refuse", pane: "Do you want to allow this operation?\n❯ 1. Yes\n  2. No" },
  { id: "permission-question-only", intent: "refuse", pane: "Do you want to proceed with this deploy?\n  gpt-5.5 · Context [████ ] · ~/code" },
  { id: "plain-history", intent: "deliver", pane: "Earlier request: 1. Fix the bug\n• Done.\n" + idle },
  { id: "marked-history", intent: "deliver", pane: "❯ 1. Fix the bug\n• Done.\n" + idle },
  { id: "quoted-menu", intent: "deliver", pane: "Report of the previous dialog:\n❯ 1. Yes\n  2. No\nThis is quoted text, not an active dialog.\n" + idle },
  { id: "literal-permission-text", intent: "deliver", pane: "The test fixture literally prints: Do you want to run the tests?\n• Done.\n" + idle },
  { id: "multiline-history", intent: "deliver", pane: "❯ 1. RED\n2. BLUE\n• Done.\n" + idle },
  { id: "identical-render-current", intent: "refuse", pane: equalRender },
  { id: "identical-render-history", intent: "deliver", pane: equalRender },
  { id: "late-choice-after-check", intent: "residual", pane: idle, late: true },
  { id: "explicit-override", intent: "deliver", pane: choice, override: true },
  { id: "force-current-choice", intent: "refuse", pane: choice, force: true },
] as const;

const records: unknown[] = [];
afterAll(() => {
  const dir = process.env.CHECKPOINT_OUTPUT;
  if (!dir) throw new Error("CHECKPOINT_OUTPUT must name this CI job's private evidence directory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "observations.json"), JSON.stringify(records, null, 2) + "\n");
});

describe("498 O1 same-input checkpoint", () => {
  for (const hook of ["Stop", "UserPromptSubmit"] as const) {
    it.each(cases)(`${hook}: $id`, async fixture => {
      const db = createFullTestDb();
      try {
        const now = new Date("2026-10-19T13:00:00.000Z");
        const rigRepo = new RigRepository(db);
        const sessionRegistry = new SessionRegistry(db);
        const eventBus = new EventBus(db);
        const store = new AgentActivityStore({ db, eventBus });
        const rig = rigRepo.createRig("checkpoint");
        const node = rigRepo.addNode(rig.id, "dev.test", { role: "worker", runtime: "claude-code" });
        const session = sessionRegistry.registerSession(node.id, "dev-test@checkpoint");
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-test@checkpoint" });
        store.recordHookEvent({ runtime: "claude-code", sessionName: "dev-test@checkpoint", hookEvent: hook,
          occurredAt: new Date(now.getTime() - 1000).toISOString() });
        const effects: Array<{ kind: string; value?: unknown }> = [];
        let pane: string | null = fixture.pane;
        const capture = vi.fn(async () => {
          effects.push({ kind: "capture" });
          if ("throws" in fixture) throw new Error("controlled capture failure");
          return pane;
        });
        const sendText = vi.fn(async (_target: string, text: string) => {
          effects.push({ kind: "paste", value: text });
          if ("late" in fixture) pane = choice;
          return { ok: true as const };
        });
        const sendKeys = vi.fn(async (_target: string, keys: string[]) => {
          effects.push({ kind: "keys", value: keys }); return { ok: true as const };
        });
        const tmux = {
          hasSession: async () => true,
          probeSession: async () => ({ state: "present" as const }),
          capturePaneContent: capture, sendText, sendKeys,
          getPaneCommand: async () => null, getPanePid: async () => null,
          listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
          createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }),
          startPipePane: async () => ({ ok: true as const }), stopPipePane: async () => ({ ok: true as const }),
        } as unknown as TmuxAdapter;
        const transport = new SessionTransport({ db, rigRepo, sessionRegistry, eventBus,
          agentActivityStore: store, tmuxAdapter: tmux, now: () => now, sleep: async () => {} });
        const result = await transport.send("dev-test@checkpoint", "Status update from a peer", {
          ...("force" in fixture ? { force: true } : {}),
          ...("override" in fixture ? { dangerouslyInteract: true, reason: "deliberate synthetic input", actorSession: "peer@checkpoint" } : {}),
        });
        records.push({ id: fixture.id, hook, intent: fixture.intent, pane: fixture.pane,
          paneVerdict: classifyPaneActivity(fixture.pane ?? ""),
          hookVerdict: store.getLatestForNode({ sessionName: "dev-test@checkpoint", now }),
          result, effects, pasteCount: sendText.mock.calls.length, keysCount: sendKeys.mock.calls.length,
          overrideCount: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='transport.prompt_override'").get() as { n: number }).n });
        // Check measurement integrity only. Policy comparisons consume every recorded result offline.
        expect(sendText.mock.calls.length).toBeLessThanOrEqual(1);
        if (!result.ok) {
          expect(sendText).not.toHaveBeenCalled();
          expect(sendKeys).not.toHaveBeenCalled();
        } else expect(sendText).toHaveBeenCalledTimes(1);
      } finally { db.close(); }
    });
  }
});
