-- Bani reservation demo — initial schema
-- Portable Postgres. No Supabase-specific constructs.

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------------------------------------------------------------- customers
create table customers (
  id           uuid primary key default gen_random_uuid(),
  wa_phone     text        not null unique,      -- E.164 digits, no '+', e.g. 962790000000
  display_name text,                             -- name the customer gave us, synthetic in demo
  locale       text        not null default 'ar' check (locale in ('ar','en')),
  consent_at   timestamptz,                      -- set when the consent line was delivered
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------------ conversations
create table conversations (
  id                   uuid        primary key default gen_random_uuid(),
  customer_id          uuid        not null references customers(id) on delete cascade,
  status               text        not null default 'open' check (status in ('open','closed')),
  started_at           timestamptz not null default now(),
  last_message_at      timestamptz not null default now(),
  last_user_message_at timestamptz,              -- drives the Meta 24-hour service window
  locked_until         timestamptz,              -- self-expiring run claim, §3.6
  created_at           timestamptz not null default now()
);

create index conversations_customer_open_idx
  on conversations (customer_id, last_message_at desc)
  where status = 'open';

-- ----------------------------------------------------------------- messages
create table messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references conversations(id) on delete cascade,
  customer_id     uuid        not null references customers(id) on delete cascade,
  role            text        not null check (role in ('user','assistant','tool')),
  content         text        not null default '',
  tool_name       text,                          -- tool that produced this row when role='tool';
                                                 -- also 'fallback_media' on the canned assistant
                                                 -- reply of §3.7, which never touches the model
  tool_payload    jsonb,                         -- tool input+output, for debugging and evals
  wa_message_id   text unique,                   -- Meta wamid; inbound dedupe key AND outbound id
  wa_direction    text        not null default 'none'
                  check (wa_direction in ('in','out','none')),
  wa_error        jsonb,                         -- Meta error body when a send fails
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at desc);
create index messages_customer_idx     on messages (customer_id, created_at desc);

-- ----------------------------------------------------------------- bookings
create table bookings (
  id              uuid        primary key default gen_random_uuid(),
  ref             text        not null unique,   -- human code, e.g. 'BK-7F3K2Q'
  customer_id     uuid        not null references customers(id) on delete restrict,
  conversation_id uuid        references conversations(id) on delete set null,
  customer_name   text        not null,          -- denormalised: survives customer edits
  service_code    text        not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text        not null default 'pending'
                  check (status in ('pending','confirmed','cancelled','failed')),
  gcal_event_id   text,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint bookings_time_order check (ends_at > starts_at),
  -- one chair: no two live bookings may overlap in time
  constraint bookings_no_overlap
    exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&)
    where (status in ('pending','confirmed'))
);

create index bookings_starts_at_idx on bookings (starts_at)
  where status in ('pending','confirmed');
create index bookings_customer_idx  on bookings (customer_id, starts_at desc);

-- ------------------------------------------------------- llm rate limiting
-- Fixed-window counter. Portable substitute for a platform rate limiter,
-- so the app stays free of Cloudflare-specific primitives.
create table rate_limit_windows (
  bucket_key   text        not null,             -- e.g. 'llm:google'
  window_start timestamptz not null,             -- truncated to the minute
  count        integer     not null default 0,
  primary key (bucket_key, window_start)
);

create index rate_limit_windows_gc_idx on rate_limit_windows (window_start);

-- ------------------------------------------------------------------ trigger
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger customers_updated_at before update on customers
  for each row execute function set_updated_at();
create trigger bookings_updated_at  before update on bookings
  for each row execute function set_updated_at();
