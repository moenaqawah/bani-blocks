import { getAccessToken, invalidateToken } from "./auth.js";

export interface InsertEventInput {
  eventId: string; // our booking uuid, dashes stripped, lowercased
  summary: string;
  description: string;
  startLocal: string; // "2026-07-28T17:00:00"
  endLocal: string; // "2026-07-28T17:30:00"
}

export async function insertEvent(
  cfg: {
    calendarId: string;
    saEmail: string;
    saPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  },
  e: InsertEventInput,
): Promise<{ created: boolean }> {
  const f = cfg.fetchImpl ?? fetch;

  async function request(): Promise<{ created: boolean }> {
    const token = await getAccessToken(cfg);

    // POST to the collection endpoint with `id` in the body — this is
    // Google's events.insert (idempotent create-with-custom-id). PUT to
    // /events/{eventId} is events.update, which 404s because the event
    // doesn't exist yet (confirmed 2026-07-28).
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId)}/events`;

    const response = await f(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: e.eventId,
        summary: e.summary,
        description: e.description,
        start: {
          dateTime: e.startLocal,
          timeZone: "Asia/Amman",
        },
        end: {
          dateTime: e.endLocal,
          timeZone: "Asia/Amman",
        },
        reminders: { useDefault: true },
      }),
    });

    if (response.status === 401) {
      invalidateToken();
      throw new Error("Token expired — retry");
    }

    if (response.status === 409) {
      // Duplicate — our own earlier attempt landed
      return { created: false };
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`insertEvent failed: ${response.status} ${body}`);
    }

    return { created: true };
  }

  try {
    return await request();
  } catch (err) {
    if (err instanceof Error && err.message === "Token expired — retry") {
      return await request();
    }
    throw err;
  }
}

export async function deleteEvent(
  cfg: {
    calendarId: string;
    saEmail: string;
    saPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  },
  eventId: string,
): Promise<void> {
  const f = cfg.fetchImpl ?? fetch;

  async function request(): Promise<void> {
    const token = await getAccessToken(cfg);

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId)}/events/${encodeURIComponent(eventId)}`;

    const response = await f(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      invalidateToken();
      throw new Error("Token expired — retry");
    }

    // 404/410 are treated as success — the event is already gone
    if (response.status === 404 || response.status === 410) {
      return;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`deleteEvent failed: ${response.status} ${body}`);
    }
  }

  try {
    await request();
  } catch (err) {
    if (err instanceof Error && err.message === "Token expired — retry") {
      await request();
      return;
    }
    throw err;
  }
}
