-- 0004_fix_state_machine.sql
-- Eliminates the "stuck pending" problem by removing `pending` from the
-- state machine entirely. Bookings now INSERT as `confirmed` directly.
--
-- Companion redesign: notes/redesign-multi-calendar-fixes.md.
--
-- Changes:
--   1. Clean any stuck pending rows.
--   2. Drop exclusion constraints that included `pending`.
--   3. Recreate with `status = 'confirmed'` only.
--   4. Drop transitional defaults from 0003.
--   5. Rebuild indexes on confirmed-only status.

-- 1. Cleanup: any row still pending is orphaned — mark it failed.
update bookings
set status = 'failed', updated_at = now()
where status = 'pending';

-- 2. Drop the old constraints that filter on (pending, confirmed).
alter table bookings drop constraint if exists bookings_no_overlap_per_resource;
alter table bookings drop constraint if exists bookings_no_overlap_per_customer;

-- 3. Recreate with confirmed-only filter.
--    A confirmed row blocks the slot. A failed/cancelled row does not.
alter table bookings add constraint bookings_no_overlap_per_resource
  exclude using gist (
    resource_code with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed');

alter table bookings add constraint bookings_no_overlap_per_customer
  exclude using gist (
    customer_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed');

-- 4. Drop transitional defaults from 0003.
alter table bookings alter column resource_code drop default;
alter table bookings alter column booking_group_id drop default;
alter table bookings alter column bundle_id drop default;

-- 5. Rebuild indexes for confirmed-only filter.
drop index if exists bookings_resource_starts_idx;
create index bookings_resource_starts_idx on bookings (resource_code, starts_at)
  where status = 'confirmed';
