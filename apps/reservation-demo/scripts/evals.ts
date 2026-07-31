#!/usr/bin/env tsx
/**
 * Translator eval — the one LLM eval ADR-004 leaves.
 *
 * Runs the labelled intent set through Layer 1 only: no database, no
 * calendar, no deployed Worker, no bookings created. Flow correctness is a
 * unit test (`pnpm run test`); this measures the single probabilistic step.
 *
 * Usage:
 *   pnpm run evals                 — run the whole set
 *   pnpm run evals -- --only T15,T30
 *   pnpm run evals -- --gate 95    — exit non-zero below this accuracy
 *
 * Reads GOOGLE_GENERATIVE_AI_API_KEY (and AI_PROVIDER / AI_MODEL) from .env.
 * Results are written to evals/translator-<date>.json.
 */

import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { getModel, translate } from "@bani/agent-core";
import { renderStateBlock, type Intent } from "@bani/orchestrator";
import { INTENT_SCHEMA } from "../src/intent-schema.js";
import { TRANSLATOR_PROMPT } from "../src/translator-prompt.js";
import { INTENT_CASES, type IntentCase } from "../evals/intent-set.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..", "..");
config({ path: join(projectRoot, ".env") });

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const ONLY = flag("only")?.split(",").map((s) => s.trim().toUpperCase()) ?? null;
const GATE = Number(flag("gate") ?? "95");
const DELAY_MS = Number(flag("delay") ?? "4500"); // stay under the free-tier RPM

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  console.error("GOOGLE_GENERATIVE_AI_API_KEY is required in .env");
  process.exit(1);
}

const model = getModel({
  AI_PROVIDER: process.env.AI_PROVIDER ?? "google",
  AI_MODEL: process.env.AI_MODEL ?? "gemini-flash-latest",
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
  ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
  ...(process.env.GROQ_API_KEY ? { GROQ_API_KEY: process.env.GROQ_API_KEY } : {}),
});

interface CaseResult {
  id: string;
  locale: string;
  message: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
  problems: string[];
}

/**
 * A case asserts on meaning, not on the whole object: every field the case
 * states must match, and the kinds must line up in order. Fields the case
 * leaves out are free — the orchestrator validates those anyway.
 */
function compare(expected: IntentCase["expect"], actual: Intent[]): string[] {
  const problems: string[] = [];

  if (actual.length !== expected.length) {
    problems.push(`expected ${expected.length} intent(s), got ${actual.length}`);
  }

  expected.forEach((want, i) => {
    const got = actual[i];
    if (!got) {
      problems.push(`[${i}] missing ${want.kind}`);
      return;
    }
    if (got.kind !== want.kind) {
      problems.push(`[${i}] expected ${want.kind}, got ${got.kind}`);
      return;
    }
    for (const [key, value] of Object.entries(want)) {
      if (key === "kind") continue;
      const actualValue = (got as Record<string, unknown>)[key];
      if (!matches(value, actualValue)) {
        problems.push(`[${i}] ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualValue)}`);
      }
    }
  });

  return problems;
}

function matches(want: unknown, got: unknown): boolean {
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return false;
    return want.length === got.length && [...want].sort().every((v, i) => v === [...got].sort()[i]);
  }
  return want === got;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCase(testCase: IntentCase): Promise<CaseResult> {
  const result = await translate<Intent>({
    model,
    systemPrompt: TRANSLATOR_PROMPT,
    stateBlock: renderStateBlock(testCase.state),
    history: [],
    userText: testCase.message,
    schema: INTENT_SCHEMA,
  });

  const problems = result.degraded
    ? ["translator returned nothing"]
    : compare(testCase.expect, result.intents);

  return {
    id: testCase.id,
    locale: testCase.locale,
    message: testCase.message,
    pass: problems.length === 0,
    expected: testCase.expect,
    actual: result.intents,
    problems,
  };
}

async function main() {
  const cases = ONLY ? INTENT_CASES.filter((c) => ONLY.includes(c.id)) : INTENT_CASES;
  console.log(`Translator eval — ${cases.length} labelled messages\n`);

  const results: CaseResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    const result = await runCase(testCase).catch((err): CaseResult => ({
      id: testCase.id,
      locale: testCase.locale,
      message: testCase.message,
      pass: false,
      expected: testCase.expect,
      actual: null,
      problems: [`threw: ${err instanceof Error ? err.message : String(err)}`],
    }));

    results.push(result);
    console.log(
      `  ${result.pass ? "✓" : "✗"} ${result.id} [${result.locale}] ${result.message}` +
        (result.pass ? "" : `\n      ${result.problems.join("\n      ")}`),
    );

    if (index < cases.length - 1) await sleep(DELAY_MS);
  }

  const passed = results.filter((r) => r.pass).length;
  const accuracy = (passed / results.length) * 100;
  console.log(`\n${passed}/${results.length} correct — ${accuracy.toFixed(1)}% (gate ${GATE}%)`);

  const byLocale = (locale: string) => {
    const subset = results.filter((r) => r.locale === locale);
    if (subset.length === 0) return "";
    return `  ${locale}: ${subset.filter((r) => r.pass).length}/${subset.length}`;
  };
  console.log([byLocale("ar"), byLocale("en")].filter(Boolean).join("\n"));

  const evalsDir = join(projectRoot, "evals");
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(
    join(evalsDir, `translator-${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ accuracy, gate: GATE, results }, null, 2),
  );

  process.exit(accuracy >= GATE ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
