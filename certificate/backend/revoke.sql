-- revoke.sql - Certificate revocation (Certificate Service, Mohamed Waleed)
-- Run once in the Supabase SQL editor.
--
-- The workshop's organizer can revoke a certificate (PATCH /certificates/{id}/revoke).
-- This is the only UPDATE the Certificate Service makes, and it is limited three ways:
--   1. certificate_service may update ONLY the three revoke columns (not names, codes, ids).
--   2. A RESTRICTIVE RLS policy (ANDed with the existing certificate_service_access policy)
--      only lets it update rows that are NOT revoked yet, and the new row must BE revoked
--      -> a certificate can be revoked once and can never be "un-revoked".
--   3. The CHECK constraint keeps the three columns consistent (all set or all empty).
--   4. anon / authenticated lose Supabase's default table grants: nothing reads this table
--      directly, everything goes through the Certificate API (RLS already blocked them; this
--      is a second layer).

ALTER TABLE public.certificates
  ADD COLUMN IF NOT EXISTS revoked_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by    UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS revoke_reason VARCHAR(200);

ALTER TABLE public.certificates DROP CONSTRAINT IF EXISTS revoke_fields_together;
ALTER TABLE public.certificates ADD CONSTRAINT revoke_fields_together CHECK (
  (revoked_at IS NULL     AND revoked_by IS NULL     AND revoke_reason IS NULL) OR
  (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
);

GRANT UPDATE (revoked_at, revoked_by, revoke_reason) ON public.certificates TO certificate_service;

DROP POLICY IF EXISTS certificate_service_revoke ON public.certificates;
CREATE POLICY certificate_service_revoke ON public.certificates
  AS RESTRICTIVE
  FOR UPDATE TO certificate_service
  USING (revoked_at IS NULL)          -- only certificates that are still valid
  WITH CHECK (revoked_at IS NOT NULL); -- and only to revoke them

REVOKE ALL ON public.certificates FROM anon, authenticated;
ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;

-- Check:
-- SELECT column_name, privilege_type FROM information_schema.column_privileges
--  WHERE table_name = 'certificates' AND grantee = 'certificate_service' AND privilege_type = 'UPDATE';

-- ---------------------------------------------------------------------
-- Revocation email: the attendee's address for a REVOKED certificate.
-- Emails live only in Supabase Auth (auth.users). Instead of giving certificate_service
-- any access to the auth schema, this one function returns a single email, and only for a
-- certificate that has already been revoked - so it cannot be used to look up other users.
-- SECURITY DEFINER = runs with the owner's rights; search_path is pinned so it can't be hijacked.
CREATE OR REPLACE FUNCTION public.revoked_certificate_email(p_certificate_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.email
  FROM public.certificates c
  JOIN public.registrations r ON r.registration_id = c.registration_id
  JOIN auth.users u ON u.id = r.attendee_id
  WHERE c.certificate_id = p_certificate_id
    AND c.revoked_at IS NOT NULL;
$$;

-- Supabase lets anon/authenticated call new public functions by default (through the REST API).
REVOKE ALL ON FUNCTION public.revoked_certificate_email(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoked_certificate_email(UUID) TO certificate_service;
