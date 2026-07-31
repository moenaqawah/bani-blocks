/**
 * An in-memory salon for the end-to-end scenario tests.
 *
 * It fakes only the two things that genuinely need a network and a database —
 * Google's busy list and the bookings table — and then calls the SAME
 * `suggestOffers` the production executor calls. A fake that reimplemented the
 * suggestion logic would pass while production broke, which is the failure
 * mode these tests exist to prevent.
 *
 * Everything else in the path is real: `runTurn`, `step()`, the availability
 * engine, the salon's own config, and the bilingual template pack.
 */

import { capableEmployees, suggestOffers, type Interval } from "@bani/availability";
import { checkFacts, checkSpeechActs } from "@bani/agent-core";
import {
  runTurn,
  type Effect,
  type EffectResult,
  type Intent,
  type ReplyBlock,
  type VisitState,
} from "@bani/orchestrator";
import { localToUtc, utcToLocalParts } from "@bani/shared";
import { BUSINESS } from "../src/config.js";
import { ORCHESTRATOR_CONFIG, serviceDuration, type Locale } from "../src/salon.js";
import { resolveReply } from "../src/reply-payload.js";

export interface Appointment {
  ref: string;
  employee: string;
  date: string;
  time: string;
  durationMin: number;
  services: string[];
  customer: "ours" | "someone-else";
}

export interface TurnLog {
  intents: Intent[];
  blocks: ReplyBlock[];
  /** The exact text a customer would receive if the renderer fell back. */
  text: string;
  effects: Effect[];
}

const span = (date: string, time: string, minutes: number): Interval => {
  const start = localToUtc(`${date}T${time}`);
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
};

export class FakeSalon {
  readonly appointments: Appointment[] = [];
  readonly log: TurnLog[] = [];

  /** Times that will fail once with SLOT_TAKEN, to simulate the TOCTOU race. */
  private readonly stolen = new Set<string>();
  private refCounter = 0;

  constructor(
    readonly now: Date,
    readonly locale: Locale = "en",
  ) {}

  /** Block out time for someone who is not our customer. */
  occupy(employee: string, date: string, time: string, minutes: number): this {
    this.appointments.push({
      ref: `EXT-${++this.refCounter}`,
      employee, date, time,
      durationMin: minutes,
      services: [],
      customer: "someone-else",
    });
    return this;
  }

  /** Fill an employee's whole day. */
  occupyDay(employee: string, date: string): this {
    return this.occupy(employee, date, `${BUSINESS.openHour}:00`, (BUSINESS.closeHour - BUSINESS.openHour) * 60);
  }

  /** The next booking attempt at this time loses the race, exactly once. */
  steal(date: string, time: string): this {
    this.stolen.add(`${date}T${time}`);
    return this;
  }

  ourBookings(): Appointment[] {
    return this.appointments.filter((a) => a.customer === "ours");
  }

  // ── the executor ────────────────────────────────────────────────────

  private busyFor(employee: string, date: string): Interval[] {
    return this.appointments
      .filter((a) => a.employee === employee && a.date === date)
      .map((a) => span(a.date, a.time, a.durationMin));
  }

  private ourBusyOn(date: string): Interval[] {
    return this.appointments
      .filter((a) => a.customer === "ours" && a.date === date)
      .map((a) => span(a.date, a.time, a.durationMin));
  }

  private execute = async (effect: Effect): Promise<EffectResult> => {
    if (effect.kind === "CancelBooking") {
      const index = this.appointments.findIndex((a) => a.ref === effect.ref);
      if (index === -1) {
        return { kind: "BookingCancelled", ok: false, ref: effect.ref, reason: "NOT_FOUND" };
      }
      const [removed] = this.appointments.splice(index, 1);
      return {
        kind: "BookingCancelled", ok: true, ref: removed!.ref,
        date: removed!.date, time: removed!.time, services: removed!.services,
      };
    }

    if (effect.kind === "FetchPastBookings") {
      const now = this.now.getTime();
      return {
        kind: "PastBookingsFetched",
        bookings: this.appointments
          .filter((a) => a.customer === "ours" && span(a.date, a.time, a.durationMin).start.getTime() < now)
          .slice(0, effect.limit)
          .map((a) => ({
            ref: a.ref, date: a.date, time: a.time, services: a.services,
            employee: a.employee, bundleId: `b-${a.ref}`, bookingGroupId: `v-${a.ref}`,
          })),
      };
    }

    if (effect.kind === "ComputeSuggestions") {
      const capable = effect.employeePref
        ? [effect.employeePref]
        : capableEmployees(effect.services, ORCHESTRATOR_CONFIG.employees);
      if (capable.length === 0) {
        return { kind: "SuggestionsComputed", group: effect.group, ok: false, reason: "NO_CAPABLE_EMPLOYEE" };
      }

      const busyByEmployee = Object.fromEntries(
        capable.map((e) => [e, this.busyFor(e, effect.date)]),
      );

      const { offers, more } = suggestOffers({
        date: effect.date,
        durationMin: effect.durationMin,
        capable,
        busyByEmployee,
        customerBusy: this.ourBusyOn(effect.date),
        hours: {
          openHour: BUSINESS.openHour,
          closeHour: BUSINESS.closeHour,
          slotMinutes: BUSINESS.slotMinutes,
        },
        leadCutoff: new Date(this.now.getTime() + BUSINESS.leadTimeMinutes * 60_000),
        cap: ORCHESTRATOR_CONFIG.maxSlotsOffered,
        maxEmployees: ORCHESTRATOR_CONFIG.maxEmployeesOffered,
        ...(effect.near ? { near: effect.near } : {}),
        ...(effect.direction ? { direction: effect.direction } : {}),
      });

      return offers.length === 0
        ? { kind: "SuggestionsComputed", group: effect.group, ok: false, reason: "NO_SLOTS" }
        : { kind: "SuggestionsComputed", group: effect.group, ok: true, offers, more };
    }

    // CreateBooking — the exclusion constraint, in miniature.
    const key = `${effect.date}T${effect.time}`;
    if (this.stolen.has(key)) {
      this.stolen.delete(key);
      this.occupy(effect.employee, effect.date, effect.time, effect.durationMin);
      return { kind: "BookingCreated", group: effect.group, ok: false, reason: "SLOT_TAKEN" };
    }

    const wanted = span(effect.date, effect.time, effect.durationMin);
    const clash = (list: Interval[]) => list.some((b) => wanted.start < b.end && wanted.end > b.start);
    if (clash(this.busyFor(effect.employee, effect.date))) {
      return { kind: "BookingCreated", group: effect.group, ok: false, reason: "SLOT_TAKEN" };
    }
    if (clash(this.ourBusyOn(effect.date))) {
      return { kind: "BookingCreated", group: effect.group, ok: false, reason: "CUSTOMER_BUSY" };
    }

    const ref = `BK-${String(++this.refCounter).padStart(6, "0")}`;
    this.appointments.push({
      ref, employee: effect.employee, date: effect.date, time: effect.time,
      durationMin: effect.durationMin, services: effect.services, customer: "ours",
    });

    return {
      kind: "BookingCreated", group: effect.group, ok: true, ref,
      date: effect.date, time: effect.time, employee: effect.employee,
      services: effect.services, durationMin: effect.durationMin,
    };
  };

  // ── driving a turn ──────────────────────────────────────────────────

  /**
   * Run one inbound message, given the intents a translator would produce.
   *
   * Also resolves the reply and checks the generated fallback against its own
   * declared facts. A resolver that emits a time or a reference it forgot to
   * register would silently defeat the Layer 3 post-check — every reply of
   * that kind would fall back forever, with only a log line to show for it.
   */
  async say(state: VisitState, ...intents: Intent[]): Promise<VisitState> {
    const effects: Effect[] = [];
    const result = await runTurn(state, intents, ORCHESTRATOR_CONFIG, async (effect) => {
      effects.push(effect);
      return this.execute(effect);
    });

    const resolved = resolveReply(result.blocks, this.locale);
    const problems = [
      ...checkFacts(resolved.fallbackText, resolved.facts).problems,
      ...checkSpeechActs(resolved.fallbackText, resolved.blocks),
    ];
    if (problems.length > 0) {
      throw new Error(
        `resolved reply does not satisfy its own guards: ${problems.join("; ")}\n` +
          `--- fallback ---\n${resolved.fallbackText}`,
      );
    }

    this.log.push({ intents, blocks: result.blocks, text: resolved.fallbackText, effects });
    return { ...result.state, ...this.refreshClock() };
  }

  /** Keep the state's view of "now" honest between turns. */
  private refreshClock() {
    const parts = utcToLocalParts(this.now);
    return { today: parts.date, nowTime: parts.time };
  }

  freshState(): VisitState {
    return {
      draft: null,
      pendingQuestion: null,
      bookings: [],
      customerName: "Lina",
      ...this.refreshClock(),
    };
  }

  // ── assertions helpers ──────────────────────────────────────────────

  get lastTurn(): TurnLog {
    return this.log[this.log.length - 1]!;
  }

  blockKinds(): string[] {
    return this.lastTurn.blocks.map((b) => b.kind);
  }

  /** Every time the customer has ever been shown, across all turns. */
  offeredTimes(): string[] {
    return this.log.flatMap((t) =>
      t.blocks.flatMap((b) =>
        b.kind === "offer_slots" || b.kind === "slot_not_offered"
          ? b.offers.flatMap((o) => o.times)
          : [],
      ),
    );
  }

  /** Booking refs the customer has been told about, across all turns. */
  confirmedRefs(): string[] {
    return this.log.flatMap((t) =>
      t.blocks.flatMap((b) => (b.kind === "booked" ? [b.ref] : [])),
    );
  }
}

export { serviceDuration };
