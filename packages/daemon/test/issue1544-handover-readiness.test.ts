// Reuses the released handover fixture. Process startup and pane bytes are modeled; no native Claude.
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const observations: unknown[] = [];
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { WatchdogAutoRegistration } from "../src/domain/watchdog-auto-registration.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DefaultOccupantInvalidator, type OccupantInvalidator } from "../src/domain/occupant-invalidator.js";

describe("SeatHandoverService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capturePaneScreen: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let claudeProcessStartedAt: ((sessionName: string) => Promise<string | null>) | undefined;
  let invalidateRetiringOccupant: ReturnType<typeof vi.fn>;
  let declareOccupantSwap: ReturnType<typeof vi.fn>;
  let resolvePredecessorRecap: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    isPaneDead = vi.fn(async () => true); // cutover: retiree exits gracefully on SIGTERM
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capturePaneScreen = vi.fn(async () => "predecessor screen tail");
    // B1 — a fresh successor is launched into a live agent (launchHarness +
    // readiness) with a scraped resume token (B2 launched-mode).
    launchHarness = vi.fn(async () => ({
      ok: true,
      resumeToken: "codex-launch-tok",
      resumeType: "codex_id",
      appliedLaunch: observeCodexSandbox(" -s workspace-write"),
    }));
    checkReady = vi.fn(async () => ({ ready: true }));
    // B2 — discovered-mode derive-helper deps (Codex thread-id capturer by default).
    readSidecar = vi.fn(() => ({ ok: true, data: { session_id: "claude-sid-123" } }));
    captureCodexThreadId = vi.fn(async () => "codex-discovered-tok");
    claudeProcessStartedAt = undefined;
    invalidateRetiringOccupant = vi.fn();
    declareOccupantSwap = vi.fn();
    resolvePredecessorRecap = vi.fn(() => ({ unavailableReason: "test default: no record" }));
    // KI-14: healthy default — the respawned pane comes up as a blank shell.
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession, createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, sendText, sendKeys, capturePaneScreen, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
  }

  function codexAdapter(): RuntimeAdapter {
    return { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function newService(adapter: TmuxAdapter = tmux(), occupantInvalidator: OccupantInvalidator = { invalidateRetiringOccupant }): SeatHandoverService {
    return new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: adapter,
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      ...(claudeProcessStartedAt ? { claudeProcessStartedAt } : {}),
      occupantInvalidator,
      activityOracle: { declareOccupantSwap },
      predecessorRecapResolver: resolvePredecessorRecap as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  function seedSeat(opts?: { rigName?: string; runtime?: string; withSession?: boolean; model?: string; codexConfigProfile?: string; effort?: string }) {
    const rig = rigRepo.createRig(opts?.rigName ?? "seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: opts?.runtime ?? "codex", cwd: "/project", model: opts?.model, codexConfigProfile: opts?.codexConfigProfile, effort: opts?.effort });
    let sessionId: string | null = null;
    if (opts?.withSession !== false) {
      const session = sessionRegistry.registerSession(node.id, `dev-impl@${rig.name}`);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: `dev-impl@${rig.name}`, tmuxPane: "%0" });
      sessionId = session.id;
    }
    return { rig, node, sessionId };
  }


  it.each(["classic-predecessor-history", "screen-without-predecessor-history", "new-runtime-already-ready"])("1544 %s", async mode => {
    seedSeat({ runtime: "claude-code" });
    let elapsed = 0, requested = false, packetPasted = false;
    const nativeAt = mode === "new-runtime-already-ready" ? 0 : 500;
    const oldFrame = "Claude Code v2.1.303\n❯ predecessor finished turn\n  ⏵⏵ accept edits on (shift+tab to cycle)";
    const freshFrame = "Claude Code v2.1.303\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)";
    const trace: unknown[] = [];
    const pane = () => requested && elapsed >= nativeAt ? freshFrame
      : mode === "classic-predecessor-history" ? oldFrame + "\noperator@host$ " : "operator@host$ ";
    getPaneCommand.mockImplementation(async () => requested && elapsed >= nativeAt ? "claude" : "zsh");
    capturePaneScreen.mockImplementation(async () => pane());
    const capturePaneContent = vi.fn(async (_session: string, lines: number) => {
      trace.push({ kind: "read", elapsed, lines, successorRuntimeStarted: requested && elapsed >= nativeAt, pane: pane() });
      return pane();
    });
    const target = { ...tmux(), capturePaneContent } as unknown as TmuxAdapter;
    const fsError = () => { throw new Error("unexpected filesystem access"); };
    const listProcesses = vi.fn(() => []);
    const claude = new ClaudeCodeAdapter({ tmux: target, fsOps: { exists: () => false, readFile: fsError,
      writeFile: fsError, mkdirp: fsError, copyFile: fsError }, listProcesses, sleep: async () => {}, sessionIdFactory: () => successorToken });
    const reads: unknown[] = [];
    const readiness = vi.fn(async (binding) => {
      const result = await claude.checkReady(binding);
      reads.push({ elapsed, successorRuntimeStarted: requested && elapsed >= nativeAt, result });
      return result;
    });
    const successorToken = "22222222-2222-4222-8222-222222222222";
    sendText.mockImplementation(async (session: string, text: string) => {
      if (text.includes("claude ") && text.includes("--session-id")) {
        requested = true; trace.push({ kind: "launch-text", elapsed, session, text, nativeAt });
        return { ok: true };
      }
      packetPasted = true;
      trace.push({ kind: "packet-paste", session, elapsed, successorRuntimeStarted: requested && elapsed >= nativeAt, text });
      return { ok: true };
    });
    sendKeys.mockImplementation(async (session: string, keys: string[]) => {
      trace.push({ kind: packetPasted ? "input" : "launch-input", session, elapsed, successorRuntimeStarted: requested && elapsed >= nativeAt, keys });
      return { ok: true };
    });
    const handover = new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: target, now: () => new Date("2026-10-19T21:30:00Z"), newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness: claude.launchHarness.bind(claude), checkReady: readiness } as unknown as RuntimeAdapter },
      contextUsageStore: { readSidecar } as never, resumeTokenCapturer: { captureCodexThreadId } as never,
      occupantInvalidator: { invalidateRetiringOccupant }, activityOracle: { declareOccupantSwap },
      predecessorRecapResolver: resolvePredecessorRecap as never, readinessTimeoutMs: 5000,
      sleep: async ms => { elapsed += ms; trace.push({ kind: "sleep", ms, elapsed }); },
    });
    const result = await handover.handover({ seatRef: "dev-impl@seat-rig", source: "fresh", reason: "bounded scrollback reproduction" });
    const sessions = db.prepare("SELECT session_name,status,resume_token,startup_status FROM sessions ORDER BY id").all();
    const oldProbe = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "zsh", paneContent: oldFrame + "\noperator@host$ " });
    observations.push({ mode, result, trace, reads, listProcessesCalls: listProcesses.mock.calls.length,
      sessions, oldProbe, respawn: respawnPane.mock.calls });
    expect(result.ok).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    // Desired invariant. It fails for the stale classic tail on the released implementation.
    expect(reads.filter((x: any) => x.result.ready).every((x: any) => x.successorRuntimeStarted)).toBe(true);
    expect(trace.filter((x: any) => x.kind === "packet-paste" || x.kind === "input")
      .every((x: any) => x.successorRuntimeStarted)).toBe(true);
  });
});

afterAll(() => {
  const dir = process.env.CHECKPOINT_OUTPUT;
  if (!dir) throw new Error("diagnostic output directory required");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
});
