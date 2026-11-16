import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  decideOnSend,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";
import type { GorgiasDraftState, GorgiasTicket } from "./types";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export async function initGorgiasWidget(): Promise<void> {
  const urlParams = new URLSearchParams(window.location.search);
  const rawSettings: Record<string, unknown> = {};
  urlParams.forEach((v, k) => {
    rawSettings[k] = v;
  });

  const settings: AppSettings = settingsFrom(rawSettings);
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app") || document.body;
  const status = el("div", { class: "status" }, "Waiting for a draft");

  let reasonCode: string | null = null;
  const quick = el("div", {
    class: "quick",
    role: "radiogroup",
    "aria-label": "Why did you change it?",
  });
  const chips: HTMLButtonElement[] = [];

  for (const q of quickReasons(settings)) {
    const b = el(
      "button",
      { type: "button", class: "chip", "data-code": q.code },
      q.label,
    ) as HTMLButtonElement;
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
    });
    chips.push(b);
    quick.appendChild(b);
  }

  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;

  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, note);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  let currentTicket: GorgiasTicket = {
    id: urlParams.get("ticket_id") || "0",
    url: window.location.href,
  };

  let composerText = "";

  mark.addEventListener("click", () => {
    if (!composerText.trim()) return;
    detector.set({ text: composerText, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  // Listen to Gorgias host messages
  window.addEventListener("message", async (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;

    if (data.type === "gorgias:ticket:loaded" || data.type === "gorgias:ticket:updated") {
      if (data.ticket && typeof data.ticket === "object") {
        currentTicket = data.ticket as GorgiasTicket;
      }
    }

    if (data.type === "gorgias:composer:change" && typeof data.text === "string") {
      composerText = data.text;
      if (detector.onComposer(composerText)) render();
    }

    if (data.type === "gorgias:ticket:send") {
      const draft: GorgiasDraftState | null = detector.current();
      if (!draft) return;

      const sentText = typeof data.text === "string" ? data.text : composerText;
      const decision = decideOnSend({
        ticket: currentTicket,
        draft,
        send: { text: sentText, fields: currentTicket.custom_fields },
        reasonCode,
        reason: reason.value,
        actor: (data.agentEmail as string | null) ?? null,
        settings,
        now: Date.now(),
      });

      if (decision.action === "skip") return;
      if (decision.action === "need-reason") {
        chips[0]?.focus();
        note.textContent = "Overturn: Please select a reason for the edit.";
        return;
      }

      try {
        const apiKey = (urlParams.get("api_key") ?? (rawSettings.overturn_api_key as string)) || "";
        const resp = await fetch(`${settings.baseUrl}/v1/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(decision.body),
        });

        if (resp.ok) {
          const r = (await resp.json()) as CaptureResult;
          lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
          note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
          reason.value = "";
          reasonCode = null;
          for (const c of chips) c.classList.remove("on");
          detector.set(null);
          render();
        }
      } catch {
        // Never block the agent or host application on failure
        note.textContent = "Overturn: Network error sending capture.";
      }
    }
  });

  render();
}

if (typeof window !== "undefined") {
  void initGorgiasWidget();
}
