import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import type { ClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import type { CredentialPrecedence } from "../src/domain/claude-credential-precedence.js";

// `rig provider switch --seat` for a Claude seat: the seat keeps its config dir, gets its own subscription token through a
// token-file reference, and resumes the same conversation by restore's own path: a snapshot taken now that resumes it, the
// seat stopped, and only that seat launched from that snapshot. Nothing changes until every check has passed.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

const SEAT = "dev-a@rig";
const CLEAR: CredentialPrecedence = { conflicts: [], checked: ["the launch environment"], notChecked: ["managed settings (a managed-settings.json file, MDM or the server)"] };

function tokenFile(contents = "fixture-file-contents") {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-switch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "work.token");
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function harness(opts: {
  runtime?: string; running?: boolean; ref?: ClaudeSeatTokenRef | null; precedence?: CredentialPrecedence;
  snapshot?: { resumes: true; conversation: string | null } | { resumes: false; why: string };
  stop?: { ok: true } | { ok: false; code: string; message: string };
  launch?: { ok: true; status: string; message?: string } | { ok: false; code: string; message: string };
} = {}) {
  const calls: string[] = [];
  let ref: ClaudeSeatTokenRef | null = opts.ref ?? null;
  const claudeSeat = {
    seat: (seat: string) => (opts.runtime ?? "claude-code") === "claude-code"
      ? { nodeId: "node-a", rigId: "rig-1", rigName: "rig", logicalId: "dev.a", running: opts.running ?? true } : null,
    tokenRef: () => ref,
    setTokenRef: (_nodeId: string, next: ClaudeSeatTokenRef | null) => { calls.push(`setTokenRef ${next ? next.label : "null"}`); ref = next; },
    snapshot: (rigId: string) => { calls.push(`snapshot ${rigId}`); return { snapshotId: "snap-1", ...(opts.snapshot ?? { resumes: true as const, conversation: "conv-1" }) }; },
    stop: async (seat: string, reason: string) => { calls.push(`stop ${seat} ${reason}`); return opts.stop ?? { ok: true as const }; },
    launch: async (rigId: string, logicalId: string, snapshotId: string) => {
      calls.push(`launch ${rigId} ${logicalId} ${snapshotId}`);
      return opts.launch ?? { ok: true as const, status: "resumed" };
    },
  };
  const claudePrecedence = async (nodeId: string) => { calls.push(`precedence ${nodeId}`); return opts.precedence ?? CLEAR; };
  const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], claudePrecedence });
  const seatRestart = { plan: async () => { throw new Error("the Codex restart isn't used for a Claude seat"); }, run: async () => { throw new Error("unused"); } };
  return { svc, seatRestart, claudeSeat, calls, ref: () => ref };
}

describe("rig provider switch --seat moves a Claude seat to its own subscription token on the same conversation", () => {
  it("checks what outranks the token, takes a snapshot that resumes the seat, sets the reference, stops the seat and resumes it from that snapshot", async () => {
    const file = tokenFile();
    const h = harness();
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "work", tokenFile: file, forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(h.calls).toEqual([
      "precedence node-a",
      "snapshot rig-1",
      "setTokenRef work",
      "stop dev-a@rig rig provider switch --to-account work",
      "launch rig-1 dev.a snap-1",
    ]);
    expect(r).toMatchObject({ outcome: "rebind_in_progress", seat: {
      seat: SEAT, account: "work", tokenFile: file, conversation: "conv-1", loginChanged: true,
      undo: `rig provider switch --seat ${SEAT} --stored-login`,
      next: expect.stringContaining("/status"),
    } });
    // The reference is metadata: the file's contents appear nowhere.
    expect(JSON.stringify(r)).not.toContain("fixture-file-contents");
    expect(h.ref()).toEqual({ label: "work", tokenFile: file });
  });

  it("a credential that outranks the token stops it before anything changes, naming each and its remedy", async () => {
    const h = harness({ precedence: { ...CLEAR, conflicts: [{ name: "ANTHROPIC_API_KEY", source: "the daemon's environment", remedy: "remove it from the daemon's allowlist" }] } });
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "work", tokenFile: tokenFile(), forceUnsafe: true }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["credential_outranks_token"],
      message: expect.stringMatching(/ANTHROPIC_API_KEY.*the daemon's environment.*remove it from the daemon's allowlist/) });
    expect(h.calls).toEqual(["precedence node-a"]);
  });

  it("a token file that wouldn't apply stops it before anything changes", async () => {
    const h = harness();
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "work", tokenFile: path.join(tmpdir(), "no-such-dir-claude-switch", "work.token"), forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["token_file_unusable"], message: expect.stringContaining("doesn't exist") });
    expect(h.calls).toEqual([]);
  });

  it("a snapshot that can't resume the seat's conversation stops it before the reference or the seat changes", async () => {
    const h = harness({ snapshot: { resumes: false, why: "has no resume token for this seat" } });
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "work", tokenFile: tokenFile(), forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["conversation_not_resumable"], message: expect.stringContaining("has no resume token") });
    expect(h.calls).toEqual(["precedence node-a", "snapshot rig-1"]);
    expect(h.ref()).toBeNull();
  });

  it("a stop that fails puts the reference back, and the seat keeps running as it was", async () => {
    const before = { label: "personal", tokenFile: tokenFile() };
    const h = harness({ ref: before, stop: { ok: false, code: "seat_not_live", message: "The seat isn't running." } });
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "work", tokenFile: tokenFile(), forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["seat_not_stopped"], message: expect.stringContaining("The seat isn't running.") });
    expect(h.ref()).toEqual(before);
    expect(h.calls.some((call) => call.startsWith("launch"))).toBe(false);
  });

  it("a relaunch that doesn't resume is reported unknown, with its recovery command and the way back, and never retried", async () => {
    const h = harness({ launch: { ok: false, code: "attention_required", message: "A resume-selection prompt is waiting." } });
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "work", tokenFile: tokenFile(), forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["relaunch_attention_required"], seat: {
      loginChanged: true, undo: `rig provider switch --seat ${SEAT} --stored-login`,
      restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1" } } });
    expect(h.calls.filter((call) => call.startsWith("launch"))).toHaveLength(1);
  });

  it("--stored-login moves the seat back to its config dir's stored login, and the way back names the reference it had", async () => {
    const before = { label: "work", tokenFile: tokenFile() };
    const h = harness({ ref: before });
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "stored-login", tokenFile: null, forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "stored-login",
      undo: `rig provider switch --seat ${SEAT} --to-account work --token-file ${before.tokenFile}` } });
    expect(h.ref()).toBeNull();
  });

  it("a stopped seat isn't relaunched: it says to launch it first, and nothing changes", async () => {
    const h = harness({ running: false });
    const r = await h.svc.switchAccount({ seat: SEAT, toAccount: "work", tokenFile: tokenFile(), forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["seat_not_running"] });
    expect(h.calls).toEqual([]);
  });

  it("precheck names the reference, whether its file would apply and what would outrank it, and changes nothing", async () => {
    const h = harness();
    const file = tokenFile();
    expect(await h.svc.precheck({ seat: SEAT, toAccount: "work", tokenFile: file }, h.seatRestart, h.claudeSeat)).toMatchObject({
      safe: true, claude: { label: "work", tokenFile: file, notChecked: CLEAR.notChecked } });
    expect(h.calls).toEqual(["precedence node-a"]);
    expect(h.ref()).toBeNull();
  });
});
