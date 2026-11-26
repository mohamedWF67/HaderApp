-- =====================================================================
-- HaderApp (Group 40) - Step 7: a limited database login for the Registration Service
-- Least privilege: the API no longer connects as "postgres" (which can do anything).
-- It connects as hader_registration, which can only use THIS service's tables.
--
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.  Safe to run again.
-- Then set the password in a SEPARATE query (never save it in this file or in GitHub):
--   ALTER ROLE hader_registration WITH PASSWORD 'choose-a-long-random-password';
-- =====================================================================

-- 1) The login (no password here on purpose).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hader_registration') THEN
    CREATE ROLE hader_registration LOGIN NOINHERIT;
  END IF;
END $$;

-- 2) Only the tables this service owns (read/write) and the shared profiles (read only).
GRANT USAGE ON SCHEMA public TO hader_registration;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.workshops, public.registrations, public.waitlist, public.notifications, public.rate_limits
  TO hader_registration;
GRANT SELECT ON public.profiles TO hader_registration;
GRANT USAGE, SELECT ON SEQUENCE
  public.workshops_workshop_id_seq, public.registrations_registration_id_seq,
  public.waitlist_waitlist_id_seq, public.notifications_notification_id_seq
  TO hader_registration;
-- No access to other services' tables, and none to Supabase's auth schema.

-- 3) The attendee list needs a person's email, which only Supabase's auth.users has.
--    Instead of opening auth.users to this login, one small function returns ONLY an email,
--    and only this login may call it.
CREATE OR REPLACE FUNCTION public.user_email(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT email::text FROM auth.users WHERE id = p_user_id $$;
REVOKE ALL ON FUNCTION public.user_email(UUID) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.user_email(UUID) FROM anon, authenticated';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.user_email(UUID) TO hader_registration;

-- 4) Row Level Security stays ON for everyone (the browser still sees nothing).
--    These policies let ONLY this login use the rows of its own tables.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workshops', 'registrations', 'waitlist', 'notifications', 'rate_limits'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                   AND policyname = 'registration_service_all') THEN
      EXECUTE format('CREATE POLICY registration_service_all ON public.%I FOR ALL TO hader_registration USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles'
                 AND policyname = 'registration_service_read') THEN
    CREATE POLICY registration_service_read ON public.profiles FOR SELECT TO hader_registration USING (true);
  END IF;
END $$;
