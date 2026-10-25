import type Database from "better-sqlite3";
import path from "node:path";

/** A Claude seat's own subscription credential: an operator label and an absolute token-file path. A reference only: the
 *  launch script reads the file when Claude starts, so the value never passes through OpenRig. The label is the
 *  operator's name for it, not an account the provider observed. */
export interface ClaudeSeatTokenRef {
  label: string;
  tokenFile: string;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** Why a label or token-file path can't be a seat's reference, or null when it can. */
export function claudeSeatTokenRefProblem(ref: ClaudeSeatTokenRef): string | null {
  if (!LABEL_RE.test(ref.label)) return "the label must start with a letter or digit, then use letters, digits, '.', '_', '@' or '-' (at most 64)";
  if (!path.isAbsolute(ref.tokenFile) || /[\0\n\r]/.test(ref.tokenFile)) return "the token file must be an absolute path on one line";
  return null;
}

/** The stored reference, or null when it's absent or unreadable. */
export function parseClaudeSeatTokenRef(value: unknown): ClaudeSeatTokenRef | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const { label, tokenFile } = JSON.parse(value) as { label?: unknown; tokenFile?: unknown };
    if (typeof label !== "string" || typeof tokenFile !== "string") return null;
    return claudeSeatTokenRefProblem({ label, tokenFile }) === null ? { label, tokenFile } : null;
  } catch {
    return null;
  }
}

/** A seat's reference, read where a launch needs it; null before the column exists. */
export function readClaudeSeatTokenRef(db: Database.Database, nodeId: string): ClaudeSeatTokenRef | null {
  const columns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "claude_token_ref")) return null;
  const row = db.prepare("SELECT claude_token_ref AS ref FROM nodes WHERE id = ?").get(nodeId) as { ref?: unknown } | undefined;
  return parseClaudeSeatTokenRef(row?.ref);
}

/** The launch-script step that gives Claude the seat's token, read from its file as Claude starts. When the file can't be
 *  read (or is empty), the step fails and Claude isn't started, rather than run on the config dir's stored login. */
export function claudeSeatTokenStep(ref: ClaudeSeatTokenRef, quote: (value: string) => string): string {
  const refusal = `OpenRig: this seat's Claude token file (${ref.label}) can't be read: ${ref.tokenFile}. Claude wasn't started, `
    + "so it doesn't run on another login. Fix the file, or choose another with rig provider switch.";
  return `{ CLAUDE_CODE_OAUTH_TOKEN=$(/bin/cat -- ${quote(ref.tokenFile)} 2>/dev/null) && [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] `
    + `&& export CLAUDE_CODE_OAUTH_TOKEN || { printf '%s\\n' ${quote(refusal)} >&2; false; }; }`;
}
