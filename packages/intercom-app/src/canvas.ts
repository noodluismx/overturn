import { type AppSettings, quickReasons, type SendDecision, statusLine } from "./capture";
import type { CanvasComponent, CanvasResponse, IntercomDraftState } from "./types";

/**
 * Generates an Intercom Canvas Kit Initialize response for the Inbox surface.
 */
export function renderInitializeCanvas(opts: {
  draft: IntercomDraftState | null;
  settings: AppSettings;
  lastResult?: { kind: string; changed: boolean; dedup: boolean } | null;
  selectedReasonCode?: string;
  note?: string;
  errorMessage?: string;
}): CanvasResponse {
  const { draft, settings, lastResult, selectedReasonCode, note, errorMessage } = opts;
  const components: CanvasComponent[] = [];

  // Header status
  components.push({
    type: "text",
    text: statusLine(draft, lastResult),
    style: "header",
  });

  if (errorMessage) {
    components.push({
      type: "text",
      text: errorMessage,
      style: "muted",
    });
  }

  if (draft) {
    components.push({ type: "spacer", size: "s" });

    // One-click reason picker options
    const reasons = quickReasons(settings);
    components.push({
      type: "single-select",
      id: "reason_code",
      label: "Why was this changed?",
      value: selectedReasonCode,
      options: reasons.map((r) => ({
        id: r.code,
        text: r.label,
      })),
    });

    components.push({
      type: "input",
      id: "reason_note",
      label: "Optional note",
      placeholder: "Anything else? Optional.",
      value: note || "",
    });

    components.push({ type: "spacer", size: "m" });

    components.push({
      type: "button",
      label: "Save Correction",
      style: "primary",
      action: {
        type: "submit",
      },
    });
  } else {
    components.push({
      type: "text",
      text: "Waiting for an AI draft to arrive in the composer...",
      style: "muted",
    });
  }

  return {
    canvas: {
      content: {
        components,
      },
    },
  };
}

/**
 * Generates the Canvas response after a teammate submits in the Canvas Kit UI.
 */
export function renderSubmitResponse(decision: SendDecision, settings: AppSettings): CanvasResponse {
  if (decision.action === "need-reason") {
    return renderInitializeCanvas({
      draft: null,
      settings,
      errorMessage: "⚠️ Please select a reason code for this change.",
    });
  }

  if (decision.action === "capture") {
    const isApprove = !decision.changed;
    return {
      canvas: {
        content: {
          components: [
            {
              type: "text",
              text: isApprove ? "✅ Sent as drafted · approved" : "✅ Captured · edit saved as a case",
              style: "header",
            },
            {
              type: "text",
              text: `Target: ${decision.body.externalId} (${decision.body.tags?.join(", ")})`,
              style: "muted",
            },
          ],
        },
      },
    };
  }

  return {
    canvas: {
      content: {
        components: [
          {
            type: "text",
            text: `Skipped capture: ${decision.why}`,
            style: "muted",
          },
        ],
      },
    },
  };
}
