import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import { assessLocalDaemonOwner } from "../src/local-daemon-owner.js";
import { allowFetchTarget } from "./fetch-guard.js";

// lsof -F0 uses NUL fields and newlines between process/file records.
const listener = (pid = 42, uid = 502, name = "127.0.0.1:7433") => `p${pid}\0u${uid}\0\nf7\0n${name}\0\n`;
const processRow = (uid = 502, start = "Tue Oct 20 03:40:00 2026") => `${uid} ${start}\n`;
function deps(outputs = [listener(), processRow(), listener(), processRow()]) {
  return {
    platform: "darwin", callerUid: 501,
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ pid: 42 }))) as unknown as typeof fetch,
    run: vi.fn(async () => {
      const next = outputs.shift();
      if (next === undefined) throw new Error("fixture exhausted");
      return next;
    }),
  };
}
describe("bounded Mac endpoint/process owner binding", () => {
  it("binds health PID, repeated listener PID/UID and process start before reporting foreign", async () => {
    const d = deps();
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "foreign", pid: 42, uid: 502, callerUid: 501 });
    expect(d.run.mock.calls.map(c => c[0])).toEqual(["/usr/sbin/lsof", "/bin/ps", "/usr/sbin/lsof", "/bin/ps"]);
  });
  it("same UID permits use but does not assert instance identity", async () => {
    const d = deps(); d.callerUid = 502;
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "same-user" });
  });
  it.each([
    ["health/listener PID mismatch", [listener(43)]],
    ["listener replacement", [listener(), processRow(), listener(43)]],
    ["PID reuse", [listener(), processRow(), listener(), processRow(502, "Tue Oct 20 03:41:00 2026")]],
    ["UID mismatch", [listener(), processRow(501)]],
    ["missing fields", ["p42\0\nf7\0n127.0.0.1:7433\0\n"]],
    ["other address", [listener(42, 502, "127.0.0.2:7433")]],
    ["multiple owners", [listener() + listener(43, 503)]],
    ["malformed UID", [listener().replace("u502", "u502oops")]],
    ["malformed process", [listener(), "502 nonsense"]],
  ])("%s remains unknown", async (_name, rows) => {
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", deps([...rows]))).toMatchObject({ state: "unknown" });
  });
  it.each(["[::1]:7433", "*:7433"])("accepts an unambiguous IPv6/wildcard binding %s", async name => {
    const rows = [listener(42, 502, name), processRow(), listener(42, 502, name), processRow()];
    expect(await assessLocalDaemonOwner("http://[::1]:7433", deps(rows))).toMatchObject({ state: "foreign" });
  });
  it("aggregates two descriptors of one listener, but refuses ambiguous localhost bindings", async () => {
    const both = listener() + "f8\0n[::1]:7433\0\n";
    expect(await assessLocalDaemonOwner("http://localhost:7433", deps([both, processRow(), both, processRow()]))).toMatchObject({ state: "foreign" });
    expect(await assessLocalDaemonOwner("http://localhost:7433", deps([listener() + listener(43, 503, "[::1]:7433")]))).toMatchObject({ state: "unknown" });
  });
  it.each(["http://remote.example:7433", "http://192.0.2.1:7433", "not a URL"])("never inspects a remote/unparseable target %s", async url => {
    const d = deps();
    expect(await assessLocalDaemonOwner(url, d)).toMatchObject({ state: "unknown" });
    expect(d.fetchImpl).not.toHaveBeenCalled(); expect(d.run).not.toHaveBeenCalled();
  });
  it.each([null, {}, { pid: "42" }, { pid: -1 }])("old or malformed health %j remains unknown", async body => {
    const d = deps(); d.fetchImpl = vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "unknown" });
    expect(d.run).not.toHaveBeenCalled();
  });
  it("unavailable tools/permissions remain unknown without a privileged fallback", async () => {
    const d = deps(); d.run.mockRejectedValue(new Error("EPERM"));
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", d)).toMatchObject({ state: "unknown" });
    expect(d.run).toHaveBeenCalledTimes(1);
  });
  it("bounds a non-cooperative health fetch and does not start OS work after expiry", async () => {
    const d = deps(); d.fetchImpl = (() => new Promise(() => {})) as typeof fetch;
    const start = performance.now();
    expect(await assessLocalDaemonOwner("http://127.0.0.1:7433", { ...d, timeoutMs: 30 })).toMatchObject({ state: "unknown" });
    expect(performance.now() - start).toBeLessThan(500);
    expect(d.run).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== "darwin" || process.env.OPENRIG_TEST_MAC_OWNER_TOOLS !== "1")("qualifies the actual Mac tools on an owned ephemeral listener", async () => {
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ pid: process.pid })));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    allowFetchTarget(url);
    try {
      const started = performance.now();
      expect(await assessLocalDaemonOwner(url)).toMatchObject({ state: "same-user", pid: process.pid, uid: process.geteuid!() });
      const elapsedMs = performance.now() - started;
      console.log(JSON.stringify({ qualification: "owned Mac listener", pid: process.pid, uid: process.geteuid!(), elapsedMs }));
      expect(elapsedMs).toBeLessThan(1500);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
