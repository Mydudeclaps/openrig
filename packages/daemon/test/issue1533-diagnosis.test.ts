// Diagnosis only: unchanged production source, modeled captures and input effects.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionTransport, classifyPaneActivity, probeSessionActivity, readInputBox, readSeatBeforePaste } from "../src/domain/session-transport.js";
import { findComposerInputLineIndex } from "../src/domain/composer-prompts.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

const quoted = "• Ran rig capture peer\n  › 1. Yes, proceed (y)\n  2. No (esc)\n  Press enter to confirm or esc to cancel";
const working = "• Working (23s • esc to interrupt)";
const reported = `${quoted}\n${working}\n› Ask Codex to do anything\nGPT-6-Astra default\n? for shortcuts`;
const supportedBox = "› Ask Codex to do anything\n\n  GPT-6-Astra default · ~/code\n  ? for shortcuts";
const supported = `${quoted}\n${working}\n\n${supportedBox}`;
const menu = "Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. No (esc)\nPress enter to confirm or esc to cancel";
const rule = "─".repeat(60);
const claudeBar = "  ⏵⏵ accept edits on (shift+tab to cycle)";
const oldQuote = "● Earlier report: Do you want to proceed?";
const claudeFrame = (head: string, draft = "") => `${oldQuote}\n\n${head}\n\n${rule}\n❯ ${draft}\n${rule}\n${claudeBar}`;
type Case = { id: string; pane: string | null; runtime?: "codex" | "claude-code"; current?: boolean; fault?: boolean };
const cases: Case[] = [
  { id: "reported-synthetic", pane: reported },
  { id: "supported-bottom-frame", pane: supported },
  { id: "supported-idle-bottom-frame", pane: `${quoted}\n\n${supportedBox}` },
  { id: "reported-without-quoted-choice", pane: `${working}\n› Ask Codex to do anything\nGPT-6-Astra default\n? for shortcuts` },
  { id: "current-codex-dialog", pane: menu, current: true },
  { id: "working-prose-before-dialog", pane: `${working}\n${menu}`, current: true },
  { id: "working-prose-after-dialog", pane: `${menu}\n${working}`, current: true },
  { id: "current-dialog-under-status", pane: `${working}\n${menu}\n\n${supportedBox}`, current: true },
  // Equal bytes, alternate underlying meaning: no classifier can distinguish intent labels.
  { id: "supported-equal-render-current-dialog", pane: supported, current: true },
  { id: "clipped-codex-permission", pane: "Would you like to run the following command?\n  GPT-6-Astra default", current: true },
  { id: "tall-claude-picker", runtime: "claude-code", pane: ["Choose", "❯ 1. Yes", ...Array.from({ length: 18 }, () => "     option description"), "  2. No", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"), current: true },
  { id: "clipped-claude-permission", runtime: "claude-code", pane: `Do you want to proceed?\n${rule}\n❯ \n${rule}\n${claudeBar}`, current: true },
  { id: "codex-draft", pane: supportedBox.replace("Ask Codex to do anything", "human draft") },
  { id: "quoted-choice-in-draft", pane: supportedBox.replace("Ask Codex to do anything", "human draft\n  › 1. Yes, proceed (y)") },
  { id: "bare-choice-history-unknown-frame", pane: `${quoted}\nunknown footer` },
  { id: "bare-working-unknown-frame", pane: `${working}\nunknown footer` },
  { id: "unknown-frame", pane: "Unrecognized terminal content" },
  { id: "null-capture", pane: null },
  { id: "failed-capture", pane: null, fault: true },
  // Useful #1323 boundary controls, recreated without its unmerged production patch.
  { id: "1323-completed-claude-history", runtime: "claude-code", pane: claudeFrame("✻ Crunched for 2s") },
  { id: "1323-current-question", runtime: "claude-code", pane: claudeFrame("Do you want to proceed?"), current: true },
  { id: "1323-draft", runtime: "claude-code", pane: claudeFrame("✻ Crunched for 2s", "typed draft") },
  { id: "1323-unknown-footer", runtime: "claude-code", pane: claudeFrame("✻ Crunched for 2s").replace(claudeBar, "unknown footer") },
];
for (const name of ["after-enter-0.4s.J.txt", "after-enter-15s.J.txt"]) {
  const pane = readFileSync(new URL(`./fixtures/input-box/codex-0.160.0/${name}`, import.meta.url), "utf8");
  const lines = pane.split("\n");
  const at = findComposerInputLineIndex(lines, "›»");
  if (at < 0) throw new Error("retained fixture lacks composer");
  lines.splice(at, 0, quoted, working, "");
  cases.push({ id: `shipped-frame-plus-synthetic-quote:${name}`, pane: lines.join("\n") });
}

const rows: unknown[] = [];
afterAll(() => {
  const dir = process.env.CHECKPOINT_OUTPUT;
  if (!dir) throw new Error("private evidence output required");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "observations.json"), JSON.stringify(rows, null, 2) + "\n");
});

describe("1533 unchanged classifier and guarded-send diagnosis", () => {
  for (const hook of ["none", "running", "permission"] as const) {
    it.each(cases)(`${hook}: $id`, async fixture => {
      const runtime = fixture.runtime ?? "codex";
      const pane = fixture.pane;
      const db = createFullTestDb();
      try {
        const now = new Date("2026-10-19T15:30:00Z");
        const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
        const store = new AgentActivityStore({ db, eventBus });
        const rig = rigRepo.createRig("diag1533");
        const node = rigRepo.addNode(rig.id, "dev.test", { role: "worker", runtime });
        const session = sessionRegistry.registerSession(node.id, "dev-test@diag1533");
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-test@diag1533" });
        if (hook !== "none") store.recordHookEvent({ runtime, sessionName: "dev-test@diag1533",
          hookEvent: hook === "running" ? "UserPromptSubmit" : runtime === "codex" ? "PermissionRequest" : "Notification",
          ...(hook === "permission" && runtime === "claude-code" ? { subtype: "permission_prompt" } : {}), occurredAt: now.toISOString() });
        const effects: unknown[] = [];
        const sendText = vi.fn(async (_target: string, value: string) => { effects.push({ paste: value }); return { ok: true as const }; });
        const sendKeys = vi.fn(async (_target: string, value: string[]) => { effects.push({ keys: value }); return { ok: true as const }; });
        const tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
          capturePaneContent: async () => { if (fixture.fault) throw new Error("controlled failed capture"); return pane; },
          sendText, sendKeys, getPaneCommand: async () => null, getPanePid: async () => null,
          listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
        } as unknown as TmuxAdapter;
        const classifier = classifyPaneActivity(pane ?? "", { runtime });
        const probe = await probeSessionActivity({ sessionName: "dev-test@diag1533", runtime, attachmentType: "tmux", tmuxAdapter: tmux, now });
        const transport = new SessionTransport({ db, rigRepo, sessionRegistry, eventBus, agentActivityStore: store,
          tmuxAdapter: tmux, now: () => now, sleep: async () => {} });
        const result = await transport.send("dev-test@diag1533", "ordinary status update");
        // Counterfactual scope experiment only, NOT a production correction. A supported box and
        // status locate a suffix; the equal-render control exposes what that DOES NOT prove.
        const inputBox = readInputBox(pane, runtime, "ordinary status update");
        const lines = (pane ?? "").split("\n");
        const inputAt = findComposerInputLineIndex(lines, runtime === "codex" ? "›»" : "❯");
        const statusAt = lines.findLastIndex((line, i) => i < inputAt && /^• Working \([^\n]*esc to interrupt\)/.test(line.trim()));
        const proposedBoundary = runtime === "codex" && inputBox === "empty" && statusAt >= 0 ? statusAt : null;
        const suffixVerdict = proposedBoundary === null ? null : classifyPaneActivity(lines.slice(proposedBoundary).join("\n"), { runtime });
        rows.push({ id: fixture.id, hook, runtime, pane, currentDialogIntent: fixture.current ?? false,
          classifier, probe, result, effects, pasteCount: sendText.mock.calls.length, keyCount: sendKeys.mock.calls.length,
          inputBox, seatBeforePaste: readSeatBeforePaste(pane, runtime), inputAt, statusAt, proposedBoundary, suffixVerdict });
        if (fixture.id === "reported-synthetic") expect(classifier).toMatchObject({ state: "attention", reason: "selection_prompt" });
        if (hook === "permission" || (fixture.current && hook === "none")) {
          expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
          expect(sendText).not.toHaveBeenCalled(); expect(sendKeys).not.toHaveBeenCalled();
        }
        if (fixture.id === "reported-synthetic" && hook === "none") expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
      } finally { db.close(); }
    });
  }
});
