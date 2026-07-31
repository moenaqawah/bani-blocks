/**
 * The state block shown to the translator.
 *
 * `kind` is really f(message, state): "11", "yes" and "tomorrow" each label
 * differently depending on what is awaiting a choice, what question is open,
 * and whether a draft exists at all. This renders exactly the facts needed to
 * resolve those references — and nothing the translator could act on, since
 * it cannot act at all.
 */

import type { VisitState } from "./types.js";

export function renderStateBlock(state: VisitState): string {
  const lines: string[] = [];

  lines.push(`TODAY: ${state.today} (now ${state.nowTime}, Amman time)`);
  lines.push(state.customerName ? `CUSTOMER NAME: ${state.customerName}` : "CUSTOMER NAME: unknown");

  lines.push("");
  lines.push(...renderDraft(state));
  lines.push("");
  lines.push(...renderQuestion(state));
  lines.push("");
  lines.push(...renderBookings(state));

  return lines.join("\n");
}

function renderDraft(state: VisitState): string[] {
  const draft = state.draft;
  if (!draft || (draft.status !== "gathering" && draft.status !== "active")) {
    return ["OPEN VISIT: none — the customer has no visit in progress."];
  }

  const lines = [`OPEN VISIT: ${draft.status}, date ${draft.visitDate ?? "not chosen yet"}`];

  if (draft.groups.length === 0) {
    lines.push("  (no services chosen yet)");
    return lines;
  }

  for (const group of draft.groups) {
    const head = `  - group "${group.key}" [${group.services.join(", ")}], ${group.durationMin} min — ${group.state}`;
    lines.push(group.employeePref ? `${head}, employee preference: ${group.employeePref}` : head);

    if (group.state === "awaiting_choice" && group.offered) {
      lines.push("    AWAITING CHOICE — these exact times were offered:");
      for (const offer of group.offered) {
        lines.push(`      ${offer.employee}: ${offer.times.join(", ")}`);
      }
    }
    if (group.state === "booked" && group.bookingRef) {
      lines.push(`    booked: ${group.bookingRef} at ${group.bookedTime} with ${group.bookedEmployee}`);
    }
  }

  return lines;
}

function renderQuestion(state: VisitState): string[] {
  const question = state.pendingQuestion;
  if (!question) return ['PENDING QUESTION: none — a bare "yes"/"no" refers to nothing.'];

  switch (question.kind) {
    case "need_services":
      return ["PENDING QUESTION: which services do you want? (an answer naming services = new_visit/modify_visit)"];
    case "need_date":
      return ["PENDING QUESTION: which day? (an answer naming a day = new_visit/modify_visit with that date)"];
    case "cancel_confirm":
      return [
        `PENDING QUESTION: confirm cancelling ${question.refs.join(", ")}? ("yes" = confirm, "no" = deny)`,
      ];
    case "replace_draft":
      return [
        `PENDING QUESTION: drop the open visit and start the new one (${question.incoming.services.join(", ")}${question.incoming.date ? ` on ${question.incoming.date}` : ""})? ("yes" = confirm, "no" = deny)`,
      ];
    case "which_booking":
      return [
        "PENDING QUESTION: which of the numbered appointments below did they mean?",
        `  An answer like "the first one", "الأول", "رقم 2" or a service name selects one —`,
        `  emit cancel with that booking's ref (${question.refs.join(", ")}).`,
        `  "all of them" / "كلهم" = cancel with scope "all".`,
      ];
  }
}

function renderBookings(state: VisitState): string[] {
  if (state.bookings.length === 0) return ["UPCOMING BOOKINGS: none."];

  // Numbered so an ordinal answer — "the first one", "الأول", "رقم 2" — has
  // something to resolve against.
  return [
    "UPCOMING BOOKINGS (in the order they were listed to the customer):",
    ...state.bookings.map(
      (b, i) =>
        `  ${i + 1}. ${b.ref}: ${b.services.join(" + ")} on ${b.date} at ${b.time} with ${b.employee}`,
    ),
  ];
}
