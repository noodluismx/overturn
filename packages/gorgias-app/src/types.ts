export interface GorgiasMessage {
  id: number | string;
  channel: "email" | "chat" | "internal-note" | "phone" | string;
  from_agent: boolean;
  sender?: {
    email?: string | null;
    name?: string | null;
  } | null;
  body_text?: string | null;
  body_html?: string | null;
  created_datetime?: string | null;
}

export interface GorgiasTicket {
  id: number | string;
  subject?: string | null;
  customer?: {
    email?: string | null;
    name?: string | null;
  } | null;
  messages?: GorgiasMessage[];
  custom_fields?: Record<string, unknown>;
  order_id?: string | number | null;
  url?: string | null;
}

export type GorgiasDraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface GorgiasDraftState {
  text: string;
  origin: GorgiasDraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}
