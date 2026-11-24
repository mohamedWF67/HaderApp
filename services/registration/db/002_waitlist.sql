-- =====================================================================
-- HaderApp (Group 40) - Step 3: waiting list (Registration Service - Nourhan)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
-- Safe to run again: it only creates what is missing.
-- =====================================================================

-- One row = one attendee waiting for a seat in a FULL workshop.
-- First in line = earliest joined_at. When a seat is freed, the backend gives it
-- to that person and deletes their row, in the same transaction.
CREATE TABLE IF NOT EXISTS public.waitlist (
  waitlist_id  SERIAL PRIMARY KEY,
  workshop_id  INTEGER     NOT NULL REFERENCES public.workshops(workshop_id) ON DELETE CASCADE,
  attendee_id  UUID        NOT NULL REFERENCES public.profiles(id),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_place_per_attendee UNIQUE (workshop_id, attendee_id)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_queue    ON public.waitlist(workshop_id, joined_at, waitlist_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_attendee ON public.waitlist(attendee_id);

-- Same protection as the other tables: the browser cannot read or change it directly.
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
