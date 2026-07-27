import { getAccessToken, invalidateToken } from "./auth.js";

export interface BusyInterval {
  start: Date;
  end: Date;
}

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
