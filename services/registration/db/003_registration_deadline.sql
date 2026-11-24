-- =====================================================================
-- HaderApp (Group 40) - Step 4: registration deadline (Registration Service - Nourhan)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
-- Safe to run again. Existing workshops get NULL = registration open until they start.
-- =====================================================================
ALTER TABLE public.workshops
  ADD COLUMN IF NOT EXISTS registration_deadline TIMESTAMPTZ;

-- The deadline can never be after the workshop starts (also checked in the backend).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deadline_not_after_start') THEN
    ALTER TABLE public.workshops
      ADD CONSTRAINT deadline_not_after_start
      CHECK (registration_deadline IS NULL OR registration_deadline <= workshop_date);
  END IF;
END $$;
