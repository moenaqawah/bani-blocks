-- Demo reset. Safe to run before any client demo.
-- Deletes conversation history and demo bookings, keeps schema.
delete from messages;
-- Guarded: 0002 is re-runnable and may execute before 0005 on a fresh database.
do $$ begin
  if to_regclass('public.visit_drafts') is not null then
    delete from visit_drafts;
  end if;
end $$;
delete from conversations;
delete from bookings where created_at > now() - interval '30 days';
delete from rate_limit_windows where window_start < now() - interval '1 hour';
