import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type LocalDaemonOwner =
  | { state: "same-user" | "foreign"; pid: number; uid: number; callerUid: number }
  | { state: "unknown"; reason: string };

interface OwnerProbeDeps {
  platform?: string;
  callerUid?: number;
  fetchImpl?: typeof fetch;
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
}
const exec = promisify(execFile);
const unknown = (reason: string): LocalDaemonOwner => ({ state: "unknown", reason });
const integer = (s: string): number | undefined => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : undefined;

/** No DNS resolution: forwarded/non-local targets cannot be bound to this OS's processes. */
function localEndpoint(baseUrl: string): { port: number; addresses: string[] } | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = host === "localhost" ? ["127.0.0.1", "[::1]"]
      : host === "::1" ? ["[::1]"] : /^127(?:\.\d{1,3}){3}$/.test(host) ? [host] : [];
    if (!addresses.length) return;
    return { port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), addresses };
  } catch { return; }
}

// -F0 is machine-readable, with process p/u followed by file f/n fields.
// Require one distinct matching owner; duplicate IPv4/IPv6 descriptors are OK.
function listenerOwner(raw: string, port: number, addresses: string[]): { pid: number; uid: number } | undefined {
  let pid: number | undefined, uid: number | undefined, file = false;
  const owners = new Map<string, { pid: number; uid: number }>();
  for (const record of raw.split("\0")) {
    const field = record.replace(/^\n+/, "");
    if (field[0] === "p") { pid = integer(field.slice(1)); uid = undefined; file = false; }
    else if (field[0] === "u") uid = integer(field.slice(1));
    else if (field[0] === "f") file = true;
    else if (field[0] === "n" && file) {
      const name = field.slice(1);
      if (name !== `*:${port}` && !addresses.some(a => name === `${a}:${port}`)) continue;
      if (pid === undefined || pid <= 0 || uid === undefined) return;
      owners.set(`${pid}:${uid}`, { pid, uid });
    }
  }
  return owners.size === 1 ? [...owners.values()][0] : undefined;
}
function processIdentity(raw: string): { uid: number; start: string } | undefined {
  // LC_ALL=C: ps lstart is a stable process-start discriminator, not a PID-only check.
  const match = raw.trim().match(/^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/);
  if (!match?.[1] || !match[2] || !Number.isFinite(Date.parse(match[2]))) return;
  const uid = integer(match[1]);
  return uid !== undefined ? { uid, start: match[2].replace(/\s+/g, " ") } : undefined;
}

/** Optional accidental-routing mitigation, not authentication or same-user instance isolation.
 * Every request observes afresh. Even repeated observations cannot make the following TCP request atomic. */
export async function assessLocalDaemonOwner(baseUrl: string, deps: OwnerProbeDeps = {}): Promise<LocalDaemonOwner> {
  const endpoint = localEndpoint(baseUrl);
  const callerUid = deps.callerUid ?? process.geteuid?.();
  if ((deps.platform ?? process.platform) !== "darwin" || !endpoint || callerUid === undefined) return unknown("not_local_mac");
  const timeoutMs = deps.timeoutMs ?? 1000;
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const run = deps.run ?? (async (file: string, args: string[], bound: number) => {
    const result = await exec(file, args, { timeout: bound, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    return result.stdout;
  });
  const observe = async (file: string, args: string[]) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0 || controller.signal.aborted) throw new Error("owner observation expired");
    return run(file, args, remaining);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<LocalDaemonOwner> => {
        const health = await (deps.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/healthz`, { signal: controller.signal, redirect: "error" });
        if (!health.ok) return unknown("health_unavailable");
        const body = await health.json() as { pid?: unknown } | null;
        const pid = body?.pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return unknown("health_pid_missing");
        const listeners = () => observe("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${endpoint.port}`, "-sTCP:LISTEN", "-F0pufn"]);
        const processes = () => observe("/bin/ps", ["-o", "uid=,lstart=", "-p", String(pid)]);
        const first = listenerOwner(await listeners(), endpoint.port, endpoint.addresses);
        if (!first || first.pid !== pid) return unknown("listener_unbound");
        const before = processIdentity(await processes());
        if (!before || before.uid !== first.uid) return unknown("process_unbound");
        const second = listenerOwner(await listeners(), endpoint.port, endpoint.addresses);
        if (!second || second.pid !== first.pid || second.uid !== first.uid) return unknown("listener_changed");
        const after = processIdentity(await processes());
        if (!after || after.uid !== before.uid || after.start !== before.start) return unknown("process_changed");
        if (controller.signal.aborted || performance.now() >= deadline) return unknown("timeout");
        return { state: first.uid === callerUid ? "same-user" : "foreign", ...first, callerUid };
      })(),
      new Promise<LocalDaemonOwner>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unknown("timeout")); }, timeoutMs); }),
    ]);
  } catch { return unknown("observation_unavailable"); }
  finally { clearTimeout(timer); controller.abort(); }
}

export class ForeignLocalDaemonError extends Error {
  readonly code = "foreign_local_daemon";
  constructor(baseUrl: string, owner: Extract<LocalDaemonOwner, { state: "same-user" | "foreign" }>) {
    super(`The optional local user guard found a different OS user at ${baseUrl} (listener PID ${owner.pid}, UID ${owner.uid}; caller UID ${owner.callerUid}). No business request was sent after this owner check. Start your own daemon on a chosen unused port, or explicitly select an intended shared/remote endpoint with OPENRIG_URL.`);
    this.name = "ForeignLocalDaemonError";
  }
}
