import { describe, expect, it } from "vitest";
import { renderInitializeCanvas, renderSubmitResponse } from "./canvas";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";
import type { CanvasTextComponent, IntercomConversation, IntercomDraftState } from "./types";

const conversation: IntercomConversation = {
  id: "998877",
  subject: "Refund request for subscription",
  teammateEmail: "support@example.com",
  customerEmail: "customer@domain.com",
  customerName: "Jane Doe",
  parts: [
    {
      id: "part_1",
      body: "<p>Hello, I was charged twice this month. Please refund.</p>",
      partType: "comment",
      author: { name: "Jane Doe", email: "customer@domain.com", type: "user" },
      createdAt: 1700000000,
    },
    {
      id: "part_2",
      body: "<p>Internal note: Checked Stripe, duplicate invoice confirmed.</p>",
      partType: "note",
      author: { name: "Alex Agent", email: "alex@example.com", isTeammate: true },
      createdAt: 1700000050,
    },
    {
      id: "part_3",
      body: "<p>Bot suggestion: We are happy to refund your payment.</p>",
      partType: "comment",
      author: { name: "Fin", isBot: true },
      createdAt: 1700000100,
    },
  ],
  url: "https://app.intercom.com/a/apps/xyz/inbox/conversation/998877",
};

const draftText =
  "Hello Jane, thank you for reaching out. We have verified the duplicate charge and processed a full refund to your original payment method within 5 business days.";

const baseDraft: IntercomDraftState = {
  text: draftText,
  origin: "ai",
  at: 10_000,
};

describe("stripHtml", () => {
  it("strips tags, decodes entities and normalizes whitespace", () => {
    expect(stripHtml("<p>Hello&nbsp;<strong>World</strong></p><br/>How are you?")).toBe(
      "Hello World\n\nHow are you?",
    );
    expect(stripHtml("Price &lt; 100 &amp; &gt; 50 &quot;deal&quot;")).toBe('Price < 100 & > 50 "deal"');
  });
});

describe("settingsFrom", () => {
  it("applies defaults when settings are empty", () => {
    const s = settingsFrom({});
    expect(s.baseUrl).toBe("https://api.overturn.run");
    expect(s.agent).toBe("support-reply");
    expect(s.requireReason).toBe(true);
    expect(s.captureInternalNotes).toBe(false);
    expect(s.minDraftChars).toBe(80);
    expect(s.reasonPack).toBe("support");
  });

  it("parses custom overrides", () => {
    const s = settingsFrom({
      overturn_base_url: "https://custom.overturn.run/",
      agent: "intercom-billing",
      require_reason: "false",
      capture_internal_notes: "true",
      min_draft_chars: "120",
      reason_pack: "claims",
      decision_fields: "tier:customer_tier, priority:sla_priority",
    });
    expect(s.baseUrl).toBe("https://custom.overturn.run");
    expect(s.agent).toBe("intercom-billing");
    expect(s.requireReason).toBe(false);
    expect(s.captureInternalNotes).toBe(true);
    expect(s.minDraftChars).toBe(120);
    expect(s.reasonPack).toBe("claims");
    expect(s.decisionFields).toEqual([
      { id: "tier", label: "customer_tier" },
      { id: "priority", label: "sla_priority" },
    ]);
  });
});

describe("contextFrom", () => {
  it("converts Intercom conversation parts to CaptureMessage context", () => {
    const ctx = contextFrom(conversation);
    expect(ctx).toHaveLength(3);
    expect(ctx[0]).toEqual({
      role: "customer",
      author: "customer@domain.com",
      content: "Hello, I was charged twice this month. Please refund.",
      at: "1700000000",
    });
    expect(ctx[1]).toEqual({
      role: "note",
      author: "alex@example.com",
      content: "Internal note: Checked Stripe, duplicate invoice confirmed.",
      at: "1700000050",
    });
    expect(ctx[2]).toEqual({
      role: "agent",
      author: "Fin",
      content: "Bot suggestion: We are happy to refund your payment.",
      at: "1700000100",
    });
  });
});

describe("statusLine", () => {
  it("describes states accurately", () => {
    expect(statusLine(null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "One two three four", origin: "ai", at: 1 })).toBe("Draft inserted · 4 words");
    expect(statusLine({ text: "One two three four", origin: "manual", at: 1 })).toBe(
      "Draft marked by you · 4 words",
    );
    expect(statusLine({ text: "One two three four", origin: "unknown", at: 1 })).toBe(
      "Draft detected · 4 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
  });
});

describe("createDraftDetector", () => {
  it("detects AI assist arrival as 'ai'", () => {
    const detector = createDraftDetector({ minDraftChars: 30 });
    const draft = detector.onComposer(draftText, true, 5_000);
    expect(draft).not.toBeNull();
    expect(draft?.origin).toBe("ai");
    expect(draft?.text).toBe(draftText);
    expect(detector.current()?.origin).toBe("ai");
  });

  it("marks manual typing as 'manual'", () => {
    const detector = createDraftDetector({ minDraftChars: 30 });
    const draft = detector.onComposer(draftText, false, 5_000);
    expect(draft?.origin).toBe("manual");
  });

  it("marks unknown origin when isAssist is omitted", () => {
    const detector = createDraftDetector({ minDraftChars: 30 });
    const draft = detector.onComposer(draftText, undefined, 5_000);
    expect(draft?.origin).toBe("unknown");
  });
});

describe("decideOnSend", () => {
  const base = {
    conversation,
    draft: baseDraft,
    send: { text: draftText, type: "reply" },
    reasonCode: null,
    reason: "",
    actor: "support@example.com",
    settings: DEFAULT_SETTINGS,
  };

  it("skips on empty sent text", () => {
    const d = decideOnSend({ ...base, send: { text: "", type: "reply" } });
    expect(d).toEqual({ action: "skip", why: "empty" });
  });

  it("skips when no draft exists", () => {
    const d = decideOnSend({ ...base, draft: null });
    expect(d).toEqual({ action: "skip", why: "no-draft" });
  });

  it("skips internal notes when captureInternalNotes is false", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "note" } });
    expect(d).toEqual({ action: "skip", why: "internal-note" });
  });

  it("sending draft unchanged is an approve capture with externalId ic:<id>", () => {
    const d = decideOnSend({ ...base });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:998877");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.tags).toEqual(["draft:ai", "reply"]);
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.context).toHaveLength(3);
  });

  it("a changed reply is an edit capture carrying the reason code and note", () => {
    const sent = draftText.replace("5 business days", "24 hours");
    const d = decideOnSend({
      ...base,
      send: { text: sent, type: "reply" },
      reasonCode: "wrong_timeline",
      reason: "Expedited for VIP customer",
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reasonCode).toBe("wrong_timeline");
    expect(d.body.reason).toBe("Expedited for VIP customer");
    expect(d.body.sent.text).toContain("24 hours");
  });

  it("require_reason blocks a changed send until a reason code is picked; note alone is not enough", () => {
    const sent = draftText.replace("verified", "denied");
    const blockedNoCode = decideOnSend({
      ...base,
      send: { text: sent, type: "reply" },
      reasonCode: null,
      reason: "No code selected",
    });
    expect(blockedNoCode).toEqual({ action: "need-reason", changedFields: [] });

    const okWithCode = decideOnSend({
      ...base,
      send: { text: sent, type: "reply" },
      reasonCode: "missed_exclusion",
      reason: "No code selected",
    });
    expect(okWithCode.action).toBe("capture");
    if (okWithCode.action === "capture") {
      expect(okWithCode.body.reasonCode).toBe("missed_exclusion");
    }
  });

  it("tags distinguish draft:ai, draft:manual, and draft:unknown", () => {
    const aiSend = decideOnSend({ ...base, draft: { ...baseDraft, origin: "ai" } });
    if (aiSend.action === "capture") expect(aiSend.body.tags).toContain("draft:ai");

    const manualSend = decideOnSend({ ...base, draft: { ...baseDraft, origin: "manual" } });
    if (manualSend.action === "capture") expect(manualSend.body.tags).toContain("draft:manual");

    const unknownSend = decideOnSend({ ...base, draft: { ...baseDraft, origin: "unknown" } });
    if (unknownSend.action === "capture") expect(unknownSend.body.tags).toContain("draft:unknown");
  });

  it("records how long the draft sat in front of the teammate (secondsToSend)", () => {
    const d = decideOnSend({
      ...base,
      draft: { ...baseDraft, at: 10_000 },
      now: 15_500,
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(5.5);
  });

  it("decision fields are tracked and differences flagged", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ id: "tier", label: "tier" }],
    };
    const d = decideOnSend({
      ...base,
      settings,
      draftFields: { tier: "standard" },
      send: { text: draftText, type: "reply", fields: { tier: "enterprise" } },
      reasonCode: "upgraded_tier",
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["tier"]);
    expect(d.body.draft.fields).toEqual({ tier: "standard" });
    expect(d.body.sent.fields).toEqual({ tier: "enterprise" });
  });
});

describe("Canvas Kit rendering", () => {
  it("renders initialize canvas with header, single-select reasons, note input and submit button", () => {
    const canvas = renderInitializeCanvas({
      draft: baseDraft,
      settings: DEFAULT_SETTINGS,
    });
    const components = canvas.canvas.content.components;
    expect(components[0]).toEqual({
      type: "text",
      text: "Draft inserted · 27 words",
      style: "header",
    });
    const select = components.find((c) => c.type === "single-select");
    expect(select).toBeDefined();
    const button = components.find((c) => c.type === "button");
    expect(button).toBeDefined();
  });

  it("renders submit response for approve and edit captures", () => {
    const approve = renderSubmitResponse(
      {
        action: "capture",
        body: {
          source: "intercom",
          externalId: "ic:998877",
          agent: "reply",
          context: [],
          draft: { text: "t" },
          sent: { text: "t" },
          tags: ["draft:ai", "reply"],
        },
        changed: false,
        changedFields: [],
      },
      DEFAULT_SETTINGS,
    );
    expect((approve.canvas.content.components[0] as CanvasTextComponent).text).toContain(
      "Sent as drafted · approved",
    );

    const edit = renderSubmitResponse(
      {
        action: "capture",
        body: {
          source: "intercom",
          externalId: "ic:998877",
          agent: "reply",
          context: [],
          draft: { text: "a" },
          sent: { text: "b" },
          tags: ["draft:ai", "reply"],
        },
        changed: true,
        changedFields: [],
      },
      DEFAULT_SETTINGS,
    );
    expect((edit.canvas.content.components[0] as CanvasTextComponent).text).toContain(
      "Captured · edit saved as a case",
    );
  });
});
