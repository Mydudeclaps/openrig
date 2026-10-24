// When someone acts on another person's ask, the server keeps it as their correspondence and changes nothing. The card
// must say so and stay pending: never emit the requested verb's outcome ("Approved") for it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MESSAGE = "Recorded as correspondence from human@host, not as human-ana@external's answer. It's kept on qitem-ask in your name; "
  + "nothing was answered, closed or unparked, and qitem-ask is still parked on human-ana@external.";

function renderVerbActions(props: Parameters<typeof VerbActions>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <VerbActions {...props} />
    </QueryClientProvider>,
  );
}

describe("VerbActions: a correspondence result", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/mission-control/action")) {
        const input = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({
          actionId: "act-1", verb: input.verb, qitemId: input.qitemId, closedQitem: { state: "blocked" }, createdQitemId: null,
          notifyAttempted: false, notifyResult: null, auditedAt: "2026-10-24T03:40:00.000Z",
          correspondence: { askedPerson: "human-ana@external", message: MESSAGE },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }));
  });

  it("does not emit approval when the server returned correspondence, shows its message, and keeps the controls", async () => {
    const onOptimisticOutcome = vi.fn();
    const onSettled = vi.fn();
    const { getByTestId } = renderVerbActions({ qitemId: "qitem-ask", actorSession: "human@host", onOptimisticOutcome, onSettled });

    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => expect(getByTestId("mc-verb-correspondence").textContent).toBe(MESSAGE));
    expect(onOptimisticOutcome).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(getByTestId("mc-verb-approve")).toBeTruthy();
  });
});
