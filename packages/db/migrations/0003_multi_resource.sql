-- 0003_multi_resource.sql
-- Multi-calendar / multi-resource support per business.
-- Turns "one business = one calendar" into "one business = N bookable
-- resources, each with its own Google Calendar".
--
-- Backward-compatible: transitional defaults keep the currently deployed
-- single-calendar code inserting valid rows in the window between
-- `pnpm run migrate` and `pnpm run deploy`.
--
-- Companion: apps/reservation-demo/src/config.ts RESOURCES array.
-- The backfill literal 'muna' MUST equal the first entry in that array.

-- btree_gist gives GiST the `=` operator class for text and uuid, needed
-- to add resource_code / customer_id to exclusion constraints.
create extension if not exists btree_gist;

-- New columns -----------------------------------------------------------
alter table bookings add column resource_code    text;
alter table bookings add column booking_group_id uuid default gen_random_uuid();
alter table bookings add column bundle_id        uuid default gen_random_uuid();

-- Backfill: every existing booking belongs to the single original chair.
update bookings set resource_code = 'muna' where resource_code is null;

-- Backfill each row as its own one-row bundle in its own visit, reusing
-- the booking's own id. Today's event id is derived from bookings.id; the
-- new rule derives it from bundle_id — so setting bundle_id = id makes
-- every existing Calendar event resolve identically under the new rule.
update bookings set booking_group_id = id, bundle_id = id;

-- Transitional defaults ------------------------------------------------
-- Keep the CURRENTLY DEPLOYED single-calendar code inserting valid rows
-- in the window between `migrate` and `deploy`. Dropped in 0004.
alter table bookings alter column resource_code set default 'muna';
alter table bookings alter column resource_code set not null;

-- Capacity constraints --------------------------------------------------
-- Drop the old unpartitioned constraint — two customers at 17:00 on two
-- different employees must now be legal.
alter table bookings drop constraint bookings_no_overlap;

-- Per-resource: no two live bookings may overlap on the SAME employee.
alter table bookings add constraint bookings_no_overlap_per_resource
  exclude using gist (
    resource_code with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending','confirmed'));

-- Per-customer: a customer may hold many bookings but never two that
-- overlap in time. Replaces the deleted one-booking-per-customer gate
-- with a stronger, race-proof guarantee enforced by the database.
alter table bookings add constraint bookings_no_overlap_per_customer
  exclude using gist (
    customer_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending','confirmed'));

-- Indexes ---------------------------------------------------------------
create index bookings_resource_starts_idx on bookings (resource_code, starts_at)
  where status in ('pending','confirmed');

create index bookings_group_idx on bookings (booking_group_id)
  where booking_group_id is not null;

create index bookings_bundle_idx on bookings (bundle_id)
  where bundle_id is not null;
