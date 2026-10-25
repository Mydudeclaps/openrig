import { claudeSeatTokenFileProblem, claudeSeatTokenRefProblem, type ClaudeSeatTokenRef } from "../claude-seat-token.js";
import type { ClaudeSwitchView, PrecheckReason, PrecheckResult } from "./provider-types.js";
import type { ClaudeCredentialPrecedence, ClaudeSeatRelaunch, ProviderPrecheckInput, ProviderSwitchInput, ProviderSwitchResult, SeatSwitchReport } from "./provider-service.js";

/** The account a Claude seat moves to when it goes back to its config dir's stored login (no token reference). */
export const STORED_LOGIN = "stored-login";

type ClaudeSeat = NonNullable<ReturnType<ClaudeSeatRelaunch["seat"]>>;
type ClaudeCheck =
  | { ok: false; verdict: Extract<PrecheckResult, { safe: false }> }
  | { ok: true; verdict: Extract<PrecheckResult, { safe: true }>; ref: ClaudeSeatTokenRef | null };

/** A Claude seat's checks, before anything changes: the reference it would get, that its file would give Claude the token,
 *  that the seat is running, and that nothing Claude Code ranks above the token is set. Managed settings (a file, MDM or
 *  the server) can't be read; the relaunched seat's /status covers them. */
export async function checkClaudeSeat(input: ProviderPrecheckInput, seat: ClaudeSeat, precedence: ClaudeCredentialPrecedence | undefined): Promise<ClaudeCheck> {
  const refuse = (reason: PrecheckReason, message: string, claude?: ClaudeSwitchView): ClaudeCheck =>
    ({ ok: false, verdict: { safe: false, reasons: [reason], message, ...(claude ? { claude } : {}) } });
  if (!precedence) return refuse("rebind_unsupported_for_runtime", "This daemon can't check what would outrank a Claude seat's own token, so it doesn't move Claude seats.");
  if (input.tokenFile === undefined) {
    return refuse("token_file_required", "A Claude seat moves to its own subscription token with --to-account <label> --token-file <absolute path to a 0600 "
      + "file holding the token>, or back to its config dir's stored login with --stored-login.");
  }
  const ref = input.tokenFile === null ? null : { label: input.toAccount, tokenFile: input.tokenFile };
  if (ref) {
    const problem = claudeSeatTokenRefProblem(ref);
    if (problem) return refuse("invalid_token_reference", `${problem}.`);
    const fileProblem = claudeSeatTokenFileProblem(ref);
    if (fileProblem) return refuse("token_file_unusable", `${fileProblem}, so Claude would start without it. Nothing changed.`);
  }
  if (!seat.running) {
    return refuse("seat_not_running", `${input.seat} isn't running, so there's no conversation to resume. Launch it first: rig launch ${seat.rigName} ${seat.logicalId}.`);
  }
  const found = await precedence(seat.nodeId);
  const claude: ClaudeSwitchView = { label: ref?.label ?? STORED_LOGIN, tokenFile: ref?.tokenFile ?? null, checked: found.checked, notChecked: found.notChecked };
  if (found.conflicts.length) {
    return refuse("credential_outranks_token", "Claude Code would use these instead, so nothing changed: "
      + `${found.conflicts.map((c) => `${c.name} (${c.source}; ${c.remedy})`).join("; ")}.`, claude);
  }
  return { ok: true, verdict: { safe: true, claude }, ref };
}

/** Move one Claude seat by restore's own resume path: a snapshot taken now that resumes the seat, its token reference set,
 *  the seat stopped, and only that seat launched from that snapshot, which reruns `claude --resume <its conversation>` with
 *  the seat's token step. Nothing changes until the snapshot is known to resume it; a failed stop puts the reference back.
 *  Never retried: a relaunch that doesn't report a resumed conversation is reported with its recovery command. */
export async function switchClaudeSeat(input: ProviderSwitchInput, relaunch: ClaudeSeatRelaunch, seat: ClaudeSeat,
  precedence: ClaudeCredentialPrecedence | undefined): Promise<ProviderSwitchResult> {
  const checked = await checkClaudeSeat(input, seat, precedence);
  if (!checked.ok) {
    const { reasons, message } = checked.verdict;
    return { outcome: "failed_safely", reasons: reasons as [string, ...string[]], ...(message ? { message } : {}) };
  }
  const { nodeId, rigId, rigName, logicalId } = seat;
  const snapshot = relaunch.snapshot(rigId, nodeId);
  if (!snapshot.resumes) {
    return { outcome: "failed_safely", reasons: ["conversation_not_resumable"],
      message: `Snapshot ${snapshot.snapshotId} ${snapshot.why}, so relaunching ${input.seat} wouldn't resume its conversation. Nothing changed.` };
  }
  const before = relaunch.tokenRef(nodeId);
  const account = checked.ref?.label ?? STORED_LOGIN;
  const report: SeatSwitchReport = { seat: input.seat, account, ...(checked.ref ? { tokenFile: checked.ref.tokenFile } : {}),
    conversation: snapshot.conversation, loginChanged: false, peers: [],
    undo: before ? `rig provider switch --seat ${input.seat} --to-account ${before.label} --token-file ${before.tokenFile}` : `rig provider switch --seat ${input.seat} --stored-login` };
  relaunch.setTokenRef(nodeId, checked.ref);
  const stopped = await relaunch.stop(input.seat, `rig provider switch --to-account ${account}`);
  if (!stopped.ok) {
    relaunch.setTokenRef(nodeId, before);
    return { outcome: "failed_safely", reasons: ["seat_not_stopped"], seat: report,
      message: `${input.seat} wasn't stopped (${stopped.code}: ${stopped.message}), so it keeps running as it was, with its token reference as it was.` };
  }
  report.loginChanged = true;
  const recoveryCommand = `rig launch ${rigName} ${logicalId} --snapshot-id ${snapshot.snapshotId}`;
  const launched = await relaunch.launch(rigId, logicalId, snapshot.snapshotId);
  if (!launched.ok) {
    report.restart = { outcome: launched.code, message: launched.message, recoveryCommand };
    return { outcome: "unknown", reasons: [`relaunch_${launched.code.replace(/-/g, "_")}`], seat: report,
      message: `${input.seat} was stopped, and its relaunch from snapshot ${snapshot.snapshotId} didn't report a resumed conversation (${launched.code}: ${launched.message}). Not retried.` };
  }
  report.restart = { outcome: "resumed", message: `Resumed conversation ${snapshot.conversation ?? "(not recorded in the snapshot)"}.` };
  report.next = `After the seat completes a turn with a tool call, its /status shows the auth method it uses: ${checked.ref
    ? `the token (CLAUDE_CODE_OAUTH_TOKEN), with no account email. "${account}" is your label for it; Claude doesn't name the account.`
    : "its config dir's stored login."}`;
  return { outcome: "rebind_in_progress", seat: report,
    message: `Relaunched ${input.seat} on ${checked.ref ? `its own token ("${account}")` : "its config dir's stored login"}, resuming its conversation. Work in flight when it stopped didn't carry over.` };
}
