-- Demo reset. Safe to run before any client demo.
-- Deletes conversation history and demo bookings, keeps schema.
delete from messages;
delete from conversations;
delete from bookings where created_at > now() - interval '30 days';
delete from rate_limit_windows where window_start < now() - interval '1 hour';
