import { loadHumanRegistry, resolveRegisteredHumanAddress, selectDefaultHuman, type HumanFragment, type LoadResult } from "./gateway/human-registry.js";
import { SettingsStore } from "./user-settings/settings-store.js";

export class WorkflowHumanDestinationError extends Error {
  readonly code = "workflow_human_destination_unavailable";
  constructor(public readonly details: { state: string; [key: string]: unknown }, message: string) {
    super(message);
    this.name = "WorkflowHumanDestinationError";
  }
}

/** The existing operator selection, resolved afresh only when a human is needed. */
export function resolveWorkflowHumanDestination(
  configured: () => unknown = () => new SettingsStore().resolveOne("workspace.operator_seat_name").value,
  registry: () => LoadResult = loadHumanRegistry,
): string {
  let selected: unknown;
  let loaded: LoadResult;
  try {
    selected = configured();
    loaded = registry();
  } catch (error) {
    throw new WorkflowHumanDestinationError({ state: "unavailable" },
      `Workflow human selection is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!loaded.ok) {
    throw new WorkflowHumanDestinationError({ state: "registry-unavailable" }, loaded.error);
  }
  const addresses = loaded.entities.map((human) => human.address);
  if (typeof selected === "string" && selected.trim()) {
    const address = resolveRegisteredHumanAddress(selected.trim(), loaded.entities);
    if (address) return address;
    throw new WorkflowHumanDestinationError({ state: "unregistered", selected, addresses },
      "workspace.operator_seat_name does not select a registered human. Inspect rig gateway human list --json and select the intended registered address.");
  }
  const fallback = selectDefaultHuman(loaded.entities);
  if (fallback) return fallback.address;
  throw new WorkflowHumanDestinationError({ state: addresses.length ? "ambiguous" : "missing", addresses },
    "Workflow human fallback needs one registered human, or a default when several exist. Inspect rig gateway human list --json; mark one with rig gateway human set <id> default yes, or select workspace.operator_seat_name. No human destination was invented.");
}

/** The person for anything that needs one without naming one (an escalation, a digest of notices, a pairing approval):
 *  workspace.operator_seat_name when it names a registered person, else the person marked default, else the only one.
 *  null when several people are registered and none is chosen: callers say so rather than pick the first. */
export function defaultHumanFor<T extends Pick<HumanFragment, "entityId" | "address" | "default">>(
  entities: readonly T[],
  configured: () => unknown = () => new SettingsStore().resolveOne("workspace.operator_seat_name").value,
): T | null {
  let selected: unknown = null;
  try { selected = configured(); } catch { selected = null; }
  const pick = selectDefaultHuman(entities, typeof selected === "string" ? selected : null);
  return pick ? entities.find((entity) => entity.address === pick.address) ?? null : null;
}

/** Explicit injected destinations remain available to embedders and isolated fixtures. */
export type WorkflowHumanDestination = string | (() => string);
export function workflowHumanDestination(selection: WorkflowHumanDestination = resolveWorkflowHumanDestination): string {
  return typeof selection === "function" ? selection() : selection;
}
