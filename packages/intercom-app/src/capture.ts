import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";
import type { IntercomConversation, IntercomDraftOrigin, IntercomDraftState, IntercomPart } from "./types";

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Require reason when the reply was changed from the draft. */
  requireReason: boolean;
  /** Also capture internal notes, not only customer-facing replies. */
  captureInternalNotes: boolean;
  /** Custom decision fields by label: e.g. [{ id: "tag", label: "tag" }]. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Minimum characters to qualify as a draft. */
  minDraftChars: number;
  /** Reason pack: "support" (default) or "claims". */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  reasonPack: "support",
};

/** Parses Intercom app settings. */
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
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** Strips HTML tags and normalizes whitespace. */
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

function role(p: IntercomPart): CaptureMessage["role"] {
  if (p.partType === "note") return "note";
  if (p.author?.isBot || p.author?.type === "bot") return "agent";
  if (p.author?.isTeammate || p.author?.type === "admin") return "agent";
  return "customer";
}

/** Converts an Intercom conversation thread to CaptureMessage array. */
export function contextFrom(conversation: IntercomConversation): CaptureMessage[] {
  return (conversation.parts || [])
    .filter((p) => p.body?.trim())
    .map((p) => ({
      role: role(p),
      author: p.author?.email ?? p.author?.name ?? null,
      content: stripHtml(p.body),
      at: p.createdAt ? String(p.createdAt) : null,
    }));
}

export interface DraftDetector {
  /** Feed composer value; returns a draft when detected. */
  onComposer(text: string, isAssist?: boolean, now?: number): IntercomDraftState | null;
  current(): IntercomDraftState | null;
  set(d: IntercomDraftState | null): void;
}

/**
 * Creates a composer draft detector.
 * If text arrives in a single leap >= minDraftChars:
 * - Marked as 'ai' if isAssist is true (e.g. Intercom Fin draft inserted)
 * - Marked as 'manual' if human typed/marked
 * - Else 'unknown' if assist origin is undetermined.
 */
export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  let draft: IntercomDraftState | null = null;
  let lastLen = 0;
  let lastTime = 0;

  return {
    onComposer: (rawText: string, isAssist?: boolean, now = Date.now()) => {
      const text = stripHtml(rawText);
      const len = text.length;
      const jump = len - lastLen;
      const elapsed = now - lastTime;
      lastLen = len;
      lastTime = now;

      if (draft) return draft;

      if (
        len >= opts.minDraftChars &&
        (jump >= opts.minDraftChars || elapsed > (opts.typingWindowMs ?? 1500))
      ) {
        let origin: IntercomDraftOrigin = "unknown";
        if (isAssist === true) {
          origin = "ai";
        } else if (isAssist === false) {
          origin = "manual";
        }
        draft = { text, origin, at: now };
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

export interface PendingSend {
  text: string;
  type: "reply" | "note" | string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/**
 * Pure evaluation on send.
 * Builds POST /v1/capture payload with:
 * - source: "intercom"
 * - externalId: "ic:<conversation_id>"
 * - tags: ["draft:ai" | "draft:manual" | "draft:unknown", ...]
 */
export function decideOnSend(input: {
  conversation: IntercomConversation;
  draft: IntercomDraftState | null;
  draftFields?: Record<string, unknown>;
  send: PendingSend;
  reasonCode?: string | null;
  reason?: string;
  actor?: string | null;
  settings?: AppSettings;
  now?: number;
}): SendDecision {
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const { conversation, draft, send } = input;
  const sentText = stripHtml(send.text);

  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "note" && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields && input.draftFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields && send.fields ? { fields: send.fields } : {}),
  };

  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = (input.reason ?? "").trim();
  const reasonCode = input.reasonCode?.trim() || null;

  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const originTag =
    draft.origin === "ai" ? "draft:ai" : draft.origin === "manual" ? "draft:manual" : "draft:unknown";

  const body: CaptureCreate = {
    source: "intercom",
    externalId: `ic:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor ?? conversation.teammateEmail ?? null,
    subject: conversation.subject ?? null,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url ?? null,
    tags: [originTag, send.type === "note" ? "internal-note" : "reply"],
    metadata: {
      customer: conversation.customerEmail ?? conversation.customerName ?? null,
    },
  };

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Status line for the Canvas Kit inbox card or composer widget. */
export function statusLine(
  d: IntercomDraftState | null,
  lastResult?: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  if (d.origin === "ai") return `Draft inserted · ${words} words`;
  if (d.origin === "manual") return `Draft marked by you · ${words} words`;
  return `Draft detected · ${words} words`;
}

/** Quick reasons for the selected pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
