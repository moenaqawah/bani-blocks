/**
 * Hand-written row types matching the SQL schema exactly.
 * snake_case field names, Date for timestamptz, string | null for nullable text.
 * No ORM, no code generation.
 */

export interface Customer {
  id: string;
  wa_phone: string;
  display_name: string | null;
  locale: "ar" | "en";
  consent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Conversation {
  id: string;
  customer_id: string;
  status: "open" | "closed";
  started_at: Date;
  last_message_at: Date;
  last_user_message_at: Date | null;
  locked_until: Date | null;
  created_at: Date;
}

export interface Message {
  id: string;
  conversation_id: string;
  customer_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name: string | null;
  tool_payload: Record<string, unknown> | null;
  wa_message_id: string | null;
  wa_direction: "in" | "out" | "none";
  wa_error: Record<string, unknown> | null;
  created_at: Date;
}

export interface Booking {
  id: string;
  ref: string;
  customer_id: string;
  conversation_id: string | null;
  customer_name: string;
  service_code: string;
  starts_at: Date;
  ends_at: Date;
  status: "pending" | "confirmed" | "cancelled" | "failed";
  gcal_event_id: string | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RateLimitWindow {
  bucket_key: string;
  window_start: Date;
  count: number;
}

// Repository row shapes, not table rows

export interface InboundRow {
  conversationId: string;
  customerId: string;
  content: string;
  waMessageId: string;
}

export interface OutboundRow {
  conversationId: string;
  customerId: string;
  content: string;
  waMessageId: string | null;
  toolName?: string;
  waError?: unknown;
}

export interface ToolRow {
  conversationId: string;
  customerId: string;
  toolName: string;
  payload: { input: unknown; output: unknown };
}

export interface NewBooking {
  customerId: string;
  conversationId: string;
  customerName: string;
  serviceCode: string;
  startsAt: Date;
  endsAt: Date;
  ref: string;
}
