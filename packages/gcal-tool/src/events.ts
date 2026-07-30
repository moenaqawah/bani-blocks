import { getAccessToken, invalidateToken } from "./auth.js";

export interface InsertEventInput {
  eventId: string; // our bundle uuid, dashes stripped, lowercased
  summary: string;
  description: string;
  startLocal: string; // "2026-07-28T17:00:00"
  endLocal: string; // "2026-07-28T17:30:00"
}

/**
 * Insert an event on a specific calendar.
 * `calendarId` is now a required parameter — no longer read from global config.
 */
export async function insertEvent(
  cfg: {
    saEmail: string;
    saPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  },
  calendarId: string,
  e: InsertEventInput,
): Promise<{ created: boolean }> {
  const f = cfg.fetchImpl ?? fetch;

  async function request(): Promise<{ created: boolean }> {
    const token = await getAccessToken(cfg);

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

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

/**
 * Delete an event from a specific calendar.
 */
export async function deleteEvent(
  cfg: {
    saEmail: string;
    saPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  },
  calendarId: string,
  eventId: string,
): Promise<void> {
  const f = cfg.fetchImpl ?? fetch;

  async function request(): Promise<void> {
    const token = await getAccessToken(cfg);

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

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

export interface GetEventResult {
  exists: boolean; // false on 404/410 — event was deleted or never existed
  status?: string; // "confirmed" | "tentative" | "cancelled" when exists
}

/**
 * Look up a single event by id on a specific calendar.
 * Used to detect a booking that was cancelled directly in Calendar
 * (e.g. by salon staff).
 */
export async function getEvent(
  cfg: {
    saEmail: string;
    saPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  },
  calendarId: string,
  eventId: string,
): Promise<GetEventResult> {
  const f = cfg.fetchImpl ?? fetch;

  async function request(): Promise<GetEventResult> {
    const token = await getAccessToken(cfg);

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

    const response = await f(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      invalidateToken();
      throw new Error("Token expired — retry");
    }

    // Google may fully purge a deleted event (404/410) or keep a
    // short-lived tombstone with status "cancelled" — handle both.
    if (response.status === 404 || response.status === 410) {
      return { exists: false };
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`getEvent failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as { status?: string };
    return { exists: true, ...(data.status !== undefined ? { status: data.status } : {}) };
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
