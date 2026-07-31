/**
 * The intent catalog — ADR-004 Layer 1's entire contract.
 *
 * The translator may only emit values of this union; the orchestrator has a
 * handler for every member. Adding a capability means adding a member here
 * AND a handler in `step.ts` — the compiler enforces the pair.
 *
 * `employee` fields carry the customer's RAW wording ("سارة", "the blonde
 * one"). Resolving raw wording to a roster code is the orchestrator's job,
 * never the translator's.
 */

import type { HHMM, ISODate } from "@bani/availability";

/** Stable group identifier — the sorted service codes joined by `+`. */
export type GroupKey = string;

export interface EmployeePref {
  service: string;
  employee: string;
}

export type Intent =
  | {
      kind: "new_visit";
      date?: ISODate;
      services: string[];
      prefs?: EmployeePref[];
    }
  | {
      kind: "modify_visit";
      add?: string[];
      remove?: string[];
      new_date?: ISODate;
      prefs?: EmployeePref[];
    }
  | { kind: "choose_slot"; group?: GroupKey; employee?: string; time: HHMM }
  | {
      kind: "other_times";
      group?: GroupKey;
      employee?: string;
      hint?: "earlier" | "later" | "another_day";
    }
  | { kind: "list_bookings"; scope?: "upcoming" | "past" | "all" }
  | { kind: "cancel"; ref?: string; scope?: "visit" | "booking" | "all" }
  | { kind: "confirm" }
  | { kind: "deny" }
  | { kind: "question"; text: string }
  | { kind: "chitchat" }
  | { kind: "unclear" };

export type IntentKind = Intent["kind"];
