-- Run once as postgres on project lydhdtlxodhyqjhvcfdu.
-- Password is provisioned separately; never add it to this file.
BEGIN;
CREATE ROLE hader_attendance LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
ALTER ROLE hader_attendance SET search_path = pg_catalog, public;
GRANT CONNECT ON DATABASE postgres TO hader_attendance;
GRANT USAGE ON SCHEMA public TO hader_attendance;
GRANT SELECT (id, name, role) ON public.profiles TO hader_attendance;
GRANT SELECT (workshop_id, title, workshop_date, organizer_id)
  ON public.workshops TO hader_attendance;
GRANT SELECT (registration_id, workshop_id, attendee_id)
  ON public.registrations TO hader_attendance;
GRANT SELECT ON public.sessions TO hader_attendance;
GRANT INSERT (workshop_id, title, start_time, end_time)
  ON public.sessions TO hader_attendance;
GRANT UPDATE (checkin_status) ON public.sessions TO hader_attendance;
GRANT SELECT (attendance_id, session_id, registration_id, checked_in_at)
  ON public.attendance TO hader_attendance;
GRANT INSERT (session_id, registration_id, checked_in_by)
  ON public.attendance TO hader_attendance;
-- SELECT FOR UPDATE needs an UPDATE privilege and an UPDATE USING policy.
-- WITH CHECK (false) rejects every actual workshop UPDATE, even a no-op.
GRANT UPDATE (workshop_id) ON public.workshops TO hader_attendance;
CREATE POLICY hader_attendance_read ON public.profiles
  FOR SELECT TO hader_attendance USING (true);
CREATE POLICY hader_attendance_read ON public.workshops
  FOR SELECT TO hader_attendance USING (true);
CREATE POLICY hader_attendance_lock ON public.workshops
  FOR UPDATE TO hader_attendance USING (true) WITH CHECK (false);
CREATE POLICY hader_attendance_read ON public.registrations
  FOR SELECT TO hader_attendance USING (true);
CREATE POLICY hader_attendance_read ON public.sessions
  FOR SELECT TO hader_attendance USING (true);
CREATE POLICY hader_attendance_insert ON public.sessions
  FOR INSERT TO hader_attendance WITH CHECK (true);
CREATE POLICY hader_attendance_checkin ON public.sessions
  FOR UPDATE TO hader_attendance USING (true) WITH CHECK (true);
CREATE POLICY hader_attendance_read ON public.attendance
  FOR SELECT TO hader_attendance USING (true);
CREATE POLICY hader_attendance_insert ON public.attendance
  FOR INSERT TO hader_attendance WITH CHECK (true);
-- Both inserted IDs are GENERATED identity columns: no sequence grant needed.
-- No broad table grants, default privileges, role memberships, or BYPASSRLS.
COMMIT;
