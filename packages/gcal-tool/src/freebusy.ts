import { getAccessToken, invalidateToken } from "./auth.js";

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface FreeBusyMultiResult {
  busy: Record<string, BusyInterval[]>;  // resourceCode → busy intervals
  errors: Record<string, string>;        // resourceCode → error reason (unreadable calendar)
}

/**
 * Query free/busy across multiple calendars in ONE request.
 * Google's freebusy.query accepts up to 50 items.
 *
 * Unreadable calendars (missing from response, or carrying errors) are
 * treated as FULLY BUSY for the queried range — this fails in the safe
 * direction: a newly added calendar that hasn't been shared yet offers
 * zero slots instead of infinite ones.
 */
export async function freeBusyMulti(
  cfg: {
    calendars: Record<string, string>;   // resourceCode → calendarId
    saEmail: string;
    saPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  },
  timeMin: Date,
  timeMax: Date,
): Promise<FreeBusyMultiResult> {
  const f = cfg.fetchImpl ?? fetch;

  async function request(): Promise<FreeBusyMultiResult> {
    const token = await getAccessToken(cfg);

    const items = Object.entries(cfg.calendars).map(([, calendarId]) => ({
      id: calendarId,
    }));

    const response = await f(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          timeZone: "Asia/Amman",
          items,
        }),
      },
    );

    if (response.status === 401) {
      invalidateToken();
      throw new Error("Token expired — retry");
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`freeBusy failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as {
      calendars?: Record<string, {
        busy?: { start: string; end: string }[];
        errors?: { reason: string }[];
      }>;
    };

    const busy: Record<string, BusyInterval[]> = {};
    const errors: Record<string, string> = {};

    // Map back from calendarId → resourceCode, and apply the safety rule
    for (const [resourceCode, calendarId] of Object.entries(cfg.calendars)) {
      const cal = data.calendars?.[calendarId];

      // Calendar missing OR has errors → fully busy (safe direction)
      if (!cal || (cal.errors && cal.errors.length > 0)) {
        const reason = cal?.errors?.[0]?.reason ?? "notFound";
        errors[resourceCode] = reason;
        // Mark as fully busy for the queried range
        busy[resourceCode] = [{ start: timeMin, end: timeMax }];
        continue;
      }

      busy[resourceCode] = (cal.busy ?? []).map((b) => ({
        start: new Date(b.start),
        end: new Date(b.end),
      }));
    }

    return { busy, errors };
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
 * Single-calendar freeBusy — kept for narrow re-checks.
 * Now takes a specific calendarId instead of reading from a global config.
 */
export async function freeBusy(
  cfg: {
    calendarId: string;
    saEmail: string;
    saPrivateKeyPem: string;
    fetchImpl?: typeof fetch;
  },
  timeMin: Date,
  timeMax: Date,
): Promise<BusyInterval[]> {
  const f = cfg.fetchImpl ?? fetch;

  async function request(): Promise<BusyInterval[]> {
    const token = await getAccessToken(cfg);

    const response = await f(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          timeZone: "Asia/Amman",
          items: [{ id: cfg.calendarId }],
        }),
      },
    );

    if (response.status === 401) {
      invalidateToken();
      throw new Error("Token expired — retry");
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`freeBusy failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as {
      calendars: Record<string, { busy?: { start: string; end: string }[] }>;
    };

    const calendar = data.calendars?.[cfg.calendarId];
    if (!calendar || !calendar.busy) return [];

    return calendar.busy.map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));
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
