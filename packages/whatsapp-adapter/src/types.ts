export interface InboundMessage {
  waMessageId: string; // value.messages[i].id — the wamid
  from: string; // E.164 digits without '+'
  timestamp: Date; // from unix seconds in value.messages[i].timestamp
  type: string; // "text" | "image" | "audio" | ...
  text: string | null; // value.messages[i].text.body when type === "text"
  profileName: string | null; // value.contacts[0].profile.name, may be absent
}

export interface SendTextParams {
  to: string; // E.164 digits without '+'
  body: string;
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}

export interface SendResult {
  waMessageId: string | null;
  error?: unknown;
}
