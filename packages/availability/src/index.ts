export * from "./types.js";
export { partitionServices, totalDuration, capableEmployees } from "./partition.js";
export { mergeCalendars, normalizeIntervals, overlapsAny } from "./calendars.js";
export { buildGrid, windowSuggestions, toHHMM } from "./window.js";
export { suggestOffers } from "./suggest.js";
export type { EmployeeOffer, SuggestParams, SuggestResult } from "./suggest.js";
