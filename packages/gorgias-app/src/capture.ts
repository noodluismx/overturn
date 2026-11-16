import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";
import type { GorgiasDraftOrigin, GorgiasDraftState, GorgiasMessage, GorgiasTicket } from "./types";

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Whether a reason is required when the final reply differs from the AI draft. */
  requireReason: boolean;
  /** Also capture internal notes. */
  captureInternalNotes: boolean;
  /** Custom decision fields by label: e.g. order_id, refund_amount. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Minimum characters to qualify as a draft. */
  minDraftChars: number;
  /** Scope tag or channel filter. */
  scopeTag: string | null;
  /** Reason pack: "support" (default for Gorgias ecommerce) or "claims". */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/** Parses Gorgias app configuration parameters. */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** Strips HTML tags and normalizes whitespace for clean capture. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export interface DraftDetector {
  onComposer(text: string, now?: number): GorgiasDraftState | null;
  current(): GorgiasDraftState | null;
  set(d: GorgiasDraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: GorgiasDraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function role(m: GorgiasMessage): CaptureMessage["role"] {
  if (m.channel === "internal-note") return "note";
  return m.from_agent ? "agent" : "customer";
}

/** Extracts the conversation context from Gorgias ticket messages. */
export function contextFrom(ticket: GorgiasTicket): CaptureMessage[] {
  const messages: GorgiasMessage[] = ticket.messages ?? [];
  return messages
    .filter((m: GorgiasMessage) => Boolean((m.body_text || m.body_html)?.trim()))
    .map((m: GorgiasMessage) => ({
      role: role(m),
      author: m.sender?.email ?? m.sender?.name ?? null,
      content: stripHtml(m.body_text || m.body_html || ""),
      at: m.created_datetime ?? null,
    }));
}

export interface PendingSend {
  text: string;
  channel?: "email" | "chat" | "internal-note" | string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** Evaluates the send action for Gorgias. Pure and side-effect free. */
export function decideOnSend(input: {
  ticket: GorgiasTicket;
  draft: GorgiasDraftState | null;
  draftFields?: Record<string, unknown>;
  send: PendingSend;
  reasonCode?: string | null;
  reason?: string;
  actor?: string | null;
  settings?: AppSettings;
  now?: number;
}): SendDecision {
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const sentText = stripHtml(input.send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (input.send.channel === "internal-note" && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!input.draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(input.draft.text),
    ...(hasFields ? { fields: input.draftFields ?? {} } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: input.send.fields ?? {} } : {}),
  };

  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = (input.reason ?? "").trim();
  const reasonCode = input.reasonCode?.trim() || null;

  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "gorgias",
    externalId: `gr:${input.ticket.id}`,
    agent: settings.agent,
    actor: input.actor ?? null,
    subject: input.ticket.subject ?? null,
    context: contextFrom(input.ticket),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - input.draft.at) / 100) / 10),
    draftRunId: input.draft.runId ?? null,
    draftModel: input.draft.model ?? null,
    url: input.ticket.url ?? null,
    tags: [
      `draft:${input.draft.origin}`,
      input.send.channel === "internal-note" ? "internal-note" : "public-reply",
    ],
    metadata: {
      requester: input.ticket.customer?.email ?? input.ticket.customer?.name ?? null,
      order_id: input.ticket.order_id ?? null,
    },
  };

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Formats user status banner text. */
export function statusLine(
  d: GorgiasDraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).length;
  const fromMap: Record<GorgiasDraftOrigin, string> = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  };
  const from = fromMap[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** Returns the available reason chips for the selected pack. */
export function quickReasons(settings: AppSettings = DEFAULT_SETTINGS): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
