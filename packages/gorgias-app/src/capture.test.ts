import { describe, expect, it } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";
import type { GorgiasDraftState, GorgiasTicket } from "./types";

const mockTicket: GorgiasTicket = {
  id: 98124,
  subject: "Where is my order #10492?",
  customer: {
    email: "sarah@example.com",
    name: "Sarah Connors",
  },
  order_id: "10492",
  url: "https://shop.gorgias.com/app/ticket/98124",
  messages: [
    {
      id: 101,
      channel: "email",
      from_agent: false,
      sender: { email: "sarah@example.com", name: "Sarah" },
      body_html: "<p>Hi, I ordered 5 days ago and haven't received a tracking update.</p>",
      created_datetime: "2026-11-15T18:00:00Z",
    },
    {
      id: 102,
      channel: "internal-note",
      from_agent: true,
      sender: { email: "ops@shop.com", name: "Warehouse" },
      body_text: "Order delayed due to storm in Memphis hub.",
      created_datetime: "2026-11-15T18:30:00Z",
    },
  ],
};

describe("Gorgias settings", () => {
  it("parses defaults with support pack", () => {
    const s = settingsFrom({});
    expect(s.baseUrl).toBe("https://api.overturn.run");
    expect(s.agent).toBe("support-reply");
    expect(s.requireReason).toBe(true);
    expect(s.reasonPack).toBe("support");
    expect(s.minDraftChars).toBe(80);
  });

  it("parses custom decision fields and parameters", () => {
    const s = settingsFrom({
      overturn_base_url: "https://api.overturn.run/",
      agent: "ecommerce-support",
      require_reason: "false",
      decision_fields: "order_id:order_id, refund_amount:refund",
      min_draft_chars: "100",
    });
    expect(s.requireReason).toBe(false);
    expect(s.agent).toBe("ecommerce-support");
    expect(s.decisionFields).toEqual([
      { id: "order_id", label: "order_id" },
      { id: "refund_amount", label: "refund" },
    ]);
    expect(s.minDraftChars).toBe(100);
  });

  it("provides support quick reason codes", () => {
    const reasons = quickReasons(DEFAULT_SETTINGS).map((r: { code: string }) => r.code);
    expect(reasons).toContain("wrong_answer");
    expect(reasons).toContain("tone_wording");
    expect(reasons).toContain("should_escalate");
  });
});

describe("HTML stripping", () => {
  it("normalizes html and replaces linebreaks", () => {
    const html = "<p>Hello <b>Sarah</b>,<br>Your order is on the way!</p>&nbsp;<div>Cheers</div>";
    const cleaned = stripHtml(html);
    expect(cleaned).toContain("Hello Sarah");
    expect(cleaned).toContain("Your order is on the way!");
    expect(cleaned).toContain("Cheers");
  });
});

describe("Draft detection", () => {
  const long = "x".repeat(200);

  it("ignores progressive manual typing and captures sudden AI draft insert", () => {
    const detector = createDraftDetector({ minDraftChars: 80 });
    expect(detector.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 50; i++) {
      text += "ab";
      expect(detector.onComposer(text, i * 100)).toBeNull();
    }
    expect(detector.current()).toBeNull();

    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    const detected = d2.onComposer(long, 500);
    expect(detected).not.toBeNull();
    expect(detected?.origin).toBe("inserted");
    expect(d2.current()?.text).toBe(long);
    expect(d2.onComposer(`${long} more`, 600)).toBeNull();
  });

  it("detects preloaded drafts on first sight", () => {
    const detector = createDraftDetector({ minDraftChars: 80 });
    const preloaded =
      "Hello Sarah, thank you for reaching out to us. I looked into order #10492 and tracking shows it will arrive tomorrow.";
    const detected = detector.onComposer(preloaded, 100);
    expect(detected?.origin).toBe("preloaded");
  });
});

describe("Context extraction", () => {
  it("builds clean context array from ticket messages", () => {
    const ctx = contextFrom(mockTicket);
    expect(ctx).toHaveLength(2);
    expect(ctx[0]?.role).toBe("customer");
    expect(ctx[0]?.author).toBe("sarah@example.com");
    expect(ctx[0]?.content).toContain("ordered 5 days ago");
    expect(ctx[1]?.role).toBe("note");
    expect(ctx[1]?.content).toContain("Order delayed due to storm");
  });
});

describe("Send decision and capture payload", () => {
  const draft: GorgiasDraftState = {
    text: "Hello Sarah, order #10492 will arrive tomorrow.",
    origin: "inserted",
    at: 1000,
  };

  it("skips send when no draft is present", () => {
    const res = decideOnSend({
      ticket: mockTicket,
      draft: null,
      send: { text: "Hello there" },
    });
    expect(res.action).toBe("skip");
    if (res.action === "skip") {
      expect(res.why).toBe("no-draft");
    }
  });

  it("skips internal note when captureInternalNotes is false", () => {
    const res = decideOnSend({
      ticket: mockTicket,
      draft,
      send: { text: "Internal update", channel: "internal-note" },
    });
    expect(res.action).toBe("skip");
    if (res.action === "skip") {
      expect(res.why).toBe("internal-note");
    }
  });

  it("approves untouched draft without requiring reason", () => {
    const res = decideOnSend({
      ticket: mockTicket,
      draft,
      send: { text: draft.text },
      settings: DEFAULT_SETTINGS,
      now: 5000,
    });
    expect(res.action).toBe("capture");
    if (res.action === "capture") {
      expect(res.changed).toBe(false);
      expect(res.body.source).toBe("gorgias");
      expect(res.body.externalId).toBe("gr:98124");
      expect(res.body.reasonCode).toBeNull();
      expect(res.body.metadata?.order_id).toBe("10492");
      expect(res.body.secondsToSend).toBe(4);
    }
  });

  it("requires reason code when draft is edited and requireReason is true", () => {
    const res = decideOnSend({
      ticket: mockTicket,
      draft,
      send: { text: "Hello Sarah, order #10492 will arrive on Thursday." },
      settings: DEFAULT_SETTINGS,
    });
    expect(res.action).toBe("need-reason");
  });

  it("generates full capture payload when edited with reason", () => {
    const res = decideOnSend({
      ticket: mockTicket,
      draft,
      send: { text: "Hello Sarah, order #10492 will arrive on Thursday." },
      reasonCode: "wrong_answer",
      reason: "Carrier delayed delivery to Thursday",
      actor: "agent@shop.com",
      settings: DEFAULT_SETTINGS,
    });
    expect(res.action).toBe("capture");
    if (res.action === "capture") {
      expect(res.changed).toBe(true);
      expect(res.body.source).toBe("gorgias");
      expect(res.body.externalId).toBe("gr:98124");
      expect(res.body.reasonCode).toBe("wrong_answer");
      expect(res.body.reason).toBe("Carrier delayed delivery to Thursday");
      expect(res.body.actor).toBe("agent@shop.com");
      expect(res.body.tags).toContain("draft:inserted");
    }
  });

  it("formats statusLine properly", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine(draft, null)).toBe("Draft inserted · 7 words");
    expect(statusLine(draft, { kind: "edit", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(draft, { kind: "edit", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
  });
});
