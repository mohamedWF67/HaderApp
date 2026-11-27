-- Removes everything the k6 end-to-end load test created (workshops titled 'k6 load test ...').
-- Run in the Supabase SQL editor after the test. Workshops with sessions cannot be deleted
-- through the API (WORKSHOP_IN_USE), so the rows are removed here in dependency order.
BEGIN;

CREATE TEMP TABLE k6_workshops ON COMMIT DROP AS
  SELECT workshop_id FROM public.workshops WHERE title LIKE 'k6 load test %';

SELECT count(*) AS workshops_to_remove FROM k6_workshops;

DELETE FROM public.certificates  WHERE workshop_id IN (SELECT workshop_id FROM k6_workshops);
DELETE FROM public.attendance    WHERE session_id IN (
  SELECT session_id FROM public.sessions WHERE workshop_id IN (SELECT workshop_id FROM k6_workshops));
DELETE FROM public.sessions      WHERE workshop_id IN (SELECT workshop_id FROM k6_workshops);
DELETE FROM public.notifications WHERE workshop_id IN (SELECT workshop_id FROM k6_workshops);
DELETE FROM public.waitlist      WHERE workshop_id IN (SELECT workshop_id FROM k6_workshops);
DELETE FROM public.registrations WHERE workshop_id IN (SELECT workshop_id FROM k6_workshops);
DELETE FROM public.workshops     WHERE workshop_id IN (SELECT workshop_id FROM k6_workshops);

COMMIT;
