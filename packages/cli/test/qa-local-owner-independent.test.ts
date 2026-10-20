import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { appendFileSync } from "node:fs";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { assessLocalDaemonOwner } from "../src/local-daemon-owner.js";
import { queueCommand } from "../src/commands/queue.js";
import { sendCommand } from "../src/commands/send.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";
import { allowFetchTarget } from "./fetch-guard.js";

type Mode = "same" | "foreign" | "old-health" | "missing-process" | "uid-disagreement" | "changed-health" | "changed-start" | "timeout";
let server: http.Server;
let base: string;
let mode: Mode;
let healthCalls: number;
let business: { method: string; url: string; sender: string | undefined }[];
let observations: { file: string; args: string[]; bound: number }[];
const caller = process.geteuid!();
const foreignUid = caller + 10000;
const start = "Tue Oct 20 03:00:00 2026";
const lifecycle = () => ({ exists: () => false, readFile: () => null, isProcessAlive: () => true,
  fetch: async () => ({ ok: true, json: async () => ({ pid: process.pid }) }) }) as unknown as LifecycleDeps;

beforeEach(async () => {
  vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
  vi.stubEnv("OPENRIG_SESSION_NAME", "qa@fixture"); vi.stubEnv("RIGGED_SESSION_NAME", "");
  vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", "true");
  mode = "same"; healthCalls = 0; business = []; observations = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") {
      healthCalls++;
      const uid = mode === "same" ? caller : foreignUid;
      const pid = mode === "changed-health" && healthCalls % 2 === 0 ? process.pid + 1 : process.pid;
      res.end(JSON.stringify(mode === "old-health" ? { pid } : { pid, euid: uid }));
    } else {
      business.push({ method: req.method!, url: req.url!, sender: req.headers["x-openrig-session"] as string | undefined });
      req.resume(); res.end("[]");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  allowFetchTarget(base); vi.stubEnv("OPENRIG_PORT", new URL(base).port);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined;
});
function client(native = false) {
  const ownerProbe = vi.fn(async (url: string) => {
    if (native) return assessLocalDaemonOwner(url);
    return assessLocalDaemonOwner(url, {
      platform: "darwin", callerUid: caller, timeoutMs: mode === "timeout" ? 25 : 1000,
      ...(mode === "timeout" ? { fetchImpl: (() => new Promise(() => {})) as typeof fetch } : {}),
      run: async (file, args, bound) => {
        observations.push({ file, args, bound });
        if (mode === "missing-process") return "";
        const uid = mode === "same" || mode === "uid-disagreement" ? caller : foreignUid;
        const born = mode === "changed-start" && observations.length % 2 === 0 ? "Tue Oct 20 03:00:01 2026" : start;
        return `${uid} ${born}\n`;
      },
    });
  });
  const options = { fetchImpl: fetch, ownerProbe };
  return { instance: new DaemonClient(base, options), ownerProbe };
}
async function commands(instance: DaemonClient) {
  const deps = { lifecycleDeps: lifecycle(), clientFactory: () => instance };
  await new Command().addCommand(queueCommand(deps)).parseAsync(["node", "rig", "queue", "list", "--json"]);
  await new Command().addCommand(sendCommand(deps)).parseAsync(["node", "rig", "send", "receiver@fixture", "independent fixture"]);
}
function expectBusiness() {
  expect(business).toHaveLength(2);
  expect(business[0]).toMatchObject({ method: "GET", sender: "qa@fixture" });
  expect(business[0]!.url).toMatch(/^\/api\/queue\/list\?/);
  expect(business[1]).toMatchObject({ method: "POST", url: "/api/transport/send", sender: "qa@fixture" });
}

describe("independent owner request boundary", () => {
  it.each([undefined, "false"])("default/off parity with main client: %s", async setting => {
    vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", setting);
    mode = "foreign";
    const { instance, ownerProbe } = client();
    await commands(instance); expectBusiness();
    expect(ownerProbe).not.toHaveBeenCalled(); expect(healthCalls).toBe(0); expect(observations).toEqual([]);
    if (process.env.QA_OWNER_TRACE) appendFileSync(process.env.QA_OWNER_TRACE,
      JSON.stringify({ setting: setting ?? "unset", trace: business }) + "\n");
  });
  it("positive foreign evidence refuses both CLI operations before business calls", async () => {
    mode = "foreign";
    const { instance } = client(); const deps = { lifecycleDeps: lifecycle(), clientFactory: () => instance };
    await expect(new Command().addCommand(queueCommand(deps)).parseAsync(["node", "rig", "queue", "list", "--json"]))
      .rejects.toMatchObject({ code: "foreign_local_daemon" });
    await expect(new Command().addCommand(sendCommand(deps)).parseAsync(["node", "rig", "send", "receiver@fixture", "independent fixture"]))
      .rejects.toMatchObject({ code: "foreign_local_daemon" });
    expect(business).toEqual([]); expect(healthCalls).toBe(4); expect(observations).toHaveLength(4);
    expect(observations.every(x => x.file === "/bin/ps" && x.bound > 0 && x.bound <= 1000)).toBe(true);
  });
  it.each(["same", "old-health", "missing-process", "uid-disagreement", "changed-health", "changed-start", "timeout"] as const)
    ("same or unknown evidence permits actual CLI calls: %s", async value => {
      mode = value; const { instance } = client(); await commands(instance); expectBusiness();
    });
  it("rechecks after a permitted request without undoing earlier business", async () => {
    const { instance } = client(); await instance.get("/api/queue"); mode = "foreign";
    await expect(instance.post("/api/transport/send", {})).rejects.toMatchObject({ code: "foreign_local_daemon" });
    expect(business.map(x => `${x.method} ${x.url}`)).toEqual(["GET /api/queue"]);
  });
  it("owned Mac listener and unprivileged process observation permit both CLI operations", async () => {
    expect(process.platform).toBe("darwin");
    const t = performance.now(); const { instance } = client(true);
    await commands(instance); expectBusiness(); expect(healthCalls).toBe(4);
    console.info(JSON.stringify({ qualification: "owned listener", pid: process.pid, uid: caller, elapsedMs: performance.now() - t }));
  });
});
