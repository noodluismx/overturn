/**
 * Intercom models and Canvas Kit interfaces.
 */

export type IntercomDraftOrigin = "ai" | "manual" | "unknown";

export interface IntercomAuthor {
  id?: string | number;
  name?: string | null;
  email?: string | null;
  type?: "user" | "lead" | "admin" | "bot" | string;
  isBot?: boolean;
  isTeammate?: boolean;
}

export interface IntercomPart {
  id?: string | number;
  body: string;
  partType: "comment" | "note" | string;
  author?: IntercomAuthor;
  createdAt?: number | string | null;
}

export interface IntercomConversation {
  id: string | number;
  subject?: string | null;
  teammateEmail?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  parts: IntercomPart[];
  customAttributes?: Record<string, unknown>;
  url?: string | null;
}

export interface IntercomDraftState {
  text: string;
  origin: IntercomDraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface CanvasTextComponent {
  type: "text";
  text: string;
  style?: "header" | "paragraph" | "muted";
  align?: "left" | "center" | "right";
}

export interface CanvasSingleSelectOption {
  id: string;
  text: string;
}

export interface CanvasSingleSelectComponent {
  type: "single-select";
  id: string;
  label?: string;
  value?: string;
  options: CanvasSingleSelectOption[];
  disabled?: boolean;
}

export interface CanvasInputComponent {
  type: "input";
  id: string;
  label?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
}

export interface CanvasButtonComponent {
  type: "button";
  label: string;
  style?: "primary" | "secondary";
  action: {
    type: "submit" | "url";
    url?: string;
  };
  disabled?: boolean;
}

export interface CanvasSpacerComponent {
  type: "spacer";
  size?: "xs" | "s" | "m" | "l";
}

export interface CanvasDividerComponent {
  type: "divider";
}

export type CanvasComponent =
  | CanvasTextComponent
  | CanvasSingleSelectComponent
  | CanvasInputComponent
  | CanvasButtonComponent
  | CanvasSpacerComponent
  | CanvasDividerComponent;

export interface CanvasResponse {
  canvas: {
    content: {
      components: CanvasComponent[];
    };
  };
}

export interface CanvasSubmitPayload {
  workspace_id?: string;
  admin?: {
    id?: string | number;
    email?: string;
    name?: string;
  };
  conversation?: IntercomConversation;
  component_id?: string;
  input_values?: Record<string, unknown>;
  current_canvas?: unknown;
}
