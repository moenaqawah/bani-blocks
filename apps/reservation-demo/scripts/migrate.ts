#!/usr/bin/env tsx
/**
 * Migration runner for @bani/db.
 *
 * Usage:
 *   pnpm run migrate          — apply pending migrations
 *   pnpm run migrate --reset  — also run 0002_seed_demo.sql (demo reset)
 *
 * Reads .env from the project root for DATABASE_URL.
 * Creates a _migrations tracking table if absent and applies
 * every .sql file in packages/db/migrations/ not yet recorded,
 * in filename order, each inside a transaction.
 */

import { createDb } from "@bani/db";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load .env
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..", "..");
config({ path: join(projectRoot, ".env") });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set in .env");
  process.exit(1);
}

const sql = createDb(DATABASE_URL);
const migrationsDir = join(projectRoot, "packages", "db", "migrations");
const isReset = process.argv.includes("--reset");

async function main() {
  console.log("Running migrations...");

  // Ensure tracking table
  await sql`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  // List migration files
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const alreadyApplied = await sql<{ name: string }[]>`
      select name from _migrations where name = ${file}
    `;

    // Skip 0002 unless --reset
    if (file === "0002_seed_demo.sql" && !isReset) {
      console.log(`  Skipping ${file} (use --reset to apply)`);
      continue;
    }

    if (alreadyApplied.length > 0 && file !== "0002_seed_demo.sql") {
      console.log(`  Already applied: ${file}`);
      continue;
    }

    // Apply migration in a transaction
    const sql_ = readFileSync(join(migrationsDir, file), "utf-8");
    console.log(`  Applying ${file}...`);

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(sql_);
        // For 0002 (re-runnable), delete the record after applying
        // so it can be run again
        if (file === "0002_seed_demo.sql") {
          await tx`delete from _migrations where name = ${file}`;
        } else {
          await tx`insert into _migrations (name) values (${file}) on conflict do nothing`;
        }
      });
      console.log(`  ✓ ${file}`);
    } catch (err) {
      console.error(`  ✗ ${file}:`, err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  console.log("Migrations complete.");
  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
