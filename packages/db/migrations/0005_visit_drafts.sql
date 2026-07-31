-- 0005_visit_drafts.sql
-- ADR-004: the deterministic orchestrator's state lives in the database,
-- not in the model's reading of message history.
--
-- One row per in-progress visit. `groups` carries the per-group state
-- machine, including `offered` — the anti-hallucination lock that makes a
-- misquoted time structurally impossible, because a slot can only be chosen
-- if it was actually offered.
--
-- Booked groups are NOT owned by this table: every booked group is an
-- ordinary independent row in `bookings` with its own ref, and survives the
-- draft being replaced, abandoned or expired.

create table visit_drafts (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references customers(id) on delete cascade,
  conversation_id  uuid references conversations(id) on delete set null,

  visit_date       date,                        -- null while gathering

  groups           jsonb not null default '[]'::jsonb,
    -- [{ key, services[], durationMin,
    --    state: 'pending'|'awaiting_choice'|'booked'|'skipped',
    --    offered: [{ employee, times[] }] | null,
    --    bookingRef: text | null, employeePref: text | null,
    --    bookedTime: text | null, bookedEmployee: text | null }]

  status           text not null default 'gathering'
                   check (status in ('gathering','active','completed','expired','abandoned')),

  -- What an unqualified "yes" refers to. Kept here rather than inferred from
  -- history so confirm/deny always has an unambiguous referent.
  pending_question jsonb,

  expires_at       timestamptz not null,        -- 24h TTL, tier-1 client config
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- At most one open draft per customer. The orchestrator's open-draft
-- conflict rule is a question it asks; this index is what makes the rule
-- impossible to bypass.
create unique index visit_drafts_one_open
  on visit_drafts (customer_id)
  where status in ('gathering','active');

create index visit_drafts_expiry_idx on visit_drafts (expires_at)
  where status in ('gathering','active');

create trigger visit_drafts_updated_at before update on visit_drafts
  for each row execute function set_updated_at();
