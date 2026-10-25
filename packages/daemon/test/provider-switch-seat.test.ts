import { describe, it, expect } from "vitest";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";

// `rig provider switch --seat`: one seat moves to a login saved in the Codex home it runs on (its own home with #1937,
// or a shared one, whose peers are named). The seat's in-place restart keeps its conversation and launch settings;
// the restart plan runs first, so a refusal changes nothing. Uptake is left to `rig seat restart --verify`.

const HOME = "/homes/seat-a";
const NOW = "2026-10-25T04:10:00.000Z";
const BEFORE = "before-switch-20261025T041000Z";
const PEER = { logicalId: "dev.qa", sessionName: "dev-qa@rig", home: "same" as const, effect: "not restarted; account unverified" };

function report(over: Record<string, unknown> = {}) {
  return { ok: true, planOnly: true, message: "planned", codexHome: HOME, peers: [], activity: { state: "idle", needsInput: null, detail: "" }, ...over };
}

function harness(opts: { plan?: Record<string, unknown>; run?: Record<string, unknown>; saved?: string[]; loggedIn?: boolean } = {}) {
  const calls: string[] = [];
  const homes = new Map([[HOME, { active: opts.loggedIn === false ? null as string | null : "personal", saved: new Set(opts.saved ?? ["personal", "work"]) }]]);
  const codexLogins = {
    list: (home: string) => [...(homes.get(home)?.saved ?? [])].sort(),
    save: (home: string, name: string) => {
      calls.push(`save ${home} ${name}`);
      const h = homes.get(home);
      if (!h?.active) return { ok: false as const, reason: "not_configured" };
      h.saved.add(name);
      return { ok: true as const, name };
    },
    activate: (home: string, name: string) => {
      calls.push(`activate ${home} ${name}`);
      const h = homes.get(home);
      if (!h?.saved.has(name)) return { ok: false as const, reason: "missing_profile" };
      h.active = name;
      return { ok: true as const };
    },
  };
  const seatRestart = {
    plan: async (seat: string) => { calls.push(`plan ${seat}`); return (opts.plan ?? report()) as never; },
    run: async (seat: string, reason: string) => {
      calls.push(`run ${seat} ${reason}`);
      return (opts.run ?? report({ planOnly: false, outcome: "restarted_account_unverified", message: "Restarted in place." })) as never;
    },
  };
  const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], codexLogins, now: () => NOW });
  return { svc, seatRestart, calls, homes };
}

describe("rig provider switch --seat moves one seat to a login saved in the Codex home it runs on", () => {
  it("plans the restart, keeps the outgoing login, activates the chosen one there, restarts in place, and leaves uptake to verify", async () => {
    const h = harness();
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(h.calls).toEqual([
      "plan dev-a@rig",
      `save ${HOME} ${BEFORE}`,
      `activate ${HOME} work`,
      "run dev-a@rig rig provider switch --to-account work",
    ]);
    expect(r).toMatchObject({
      outcome: "rebind_in_progress",
      seat: { seat: "dev-a@rig", home: HOME, account: "work", loginChanged: true, savedBefore: BEFORE,
        undo: `rig auth switch --codex-home ${HOME} ${BEFORE}`, restart: { outcome: "restarted_account_unverified" },
        next: expect.stringContaining("rig seat restart dev-a@rig --keep-conversation --verify --expect-account") },
    });
    expect(h.homes.get(HOME)!.active).toBe("work");
  });

  it("names every peer on a shared home: not restarted, and its account unverified", async () => {
    const h = harness({ plan: report({ peers: [PEER] }), run: report({ planOnly: false, outcome: "restarted_account_unverified", peers: [PEER] }) });
    expect(await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart))
      .toMatchObject({ safe: true, seat: { home: HOME, activity: "idle", peers: [PEER] } });
    expect(await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart))
      .toMatchObject({ outcome: "rebind_in_progress", seat: { peers: [PEER] } });
  });

  it("an unknown sign-in state doesn't stop an authorized move", async () => {
    const h = harness();
    const verdict = await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart);
    expect(verdict).toMatchObject({ safe: true });
    expect(verdict).not.toHaveProperty("reasons");
  });

  it("a refused restart plan changes nothing: the home's login stays, and the refusal is named", async () => {
    const h = harness({ plan: { ok: false, code: "settings_unverified", message: "Couldn't read the running Codex's environment." } });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: true }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["seat_restart_refused"], message: expect.stringContaining("settings_unverified") });
    expect(h.calls).toEqual(["plan dev-a@rig"]);
    expect(h.homes.get(HOME)!.active).toBe("personal");
  });

  it("a Claude seat isn't switched: its runtime has no account switch yet", async () => {
    const h = harness({ plan: { ok: false, code: "not_codex", message: "Seat \"dev-a@rig\" runs claude-code; in-place restart supports Codex seats only." } });
    expect(await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart))
      .toMatchObject({ safe: false, reasons: ["rebind_unsupported_for_runtime"] });
    expect(await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart))
      .toMatchObject({ outcome: "failed_safely", reasons: ["rebind_unsupported_for_runtime"] });
    expect(h.calls.some((call) => call.startsWith("activate"))).toBe(false);
  });

  it("a login that isn't saved in the seat's home is named, with how to list the ones that are", async () => {
    const h = harness({ saved: ["personal"] });
    expect(await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart)).toMatchObject({
      safe: false, reasons: ["target_not_in_seat_home"], message: expect.stringContaining(`rig auth list --codex-home ${HOME}`),
    });
    expect(h.calls.some((call) => call.startsWith("activate") || call.startsWith("run"))).toBe(false);
  });

  it("a restart that can't confirm is reported as unknown, with its recovery command, and never retried", async () => {
    const h = harness({ run: report({ planOnly: false, outcome: "native_unknown", recoveryCommand: "codex resume abc", message: "The replacement Codex wasn't observed." }) });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["restart_native_unknown"],
      seat: { loginChanged: true, restart: { outcome: "native_unknown", recoveryCommand: "codex resume abc" } } });
    expect(h.calls.filter((call) => call.startsWith("run"))).toHaveLength(1);
  });

  it("a restart refused after the login changed says so, with the way back", async () => {
    const h = harness({ run: { ok: false, code: "restart_in_progress", message: "Another restart of this seat is running." } });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["login_changed_seat_not_restarted"],
      message: expect.stringContaining("Another restart of this seat is running."),
      seat: { loginChanged: true, undo: `rig auth switch --codex-home ${HOME} ${BEFORE}` } });
  });

  it("a home with no active login moves without a before copy, and says there's nothing to switch back to", async () => {
    const h = harness({ loggedIn: false });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "rebind_in_progress", seat: { savedBefore: null, undo: null, loginChanged: true } });
    expect(h.homes.get(HOME)!.active).toBe("work");
  });
});
