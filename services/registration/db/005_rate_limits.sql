-- =====================================================================
-- HaderApp (Group 40) - Step 6: rate limiting (Registration Service - Nourhan)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.  Safe to run again.
-- =====================================================================

-- One row per caller address per minute, counting its requests.
-- The backend answers 429 once the count passes the limit (100 per minute by default).
-- Old rows are deleted by the scheduled checks every minute.
CREATE TABLE IF NOT EXISTS public.rate_limits (
  bucket        VARCHAR(100) NOT NULL,
  window_start  TIMESTAMPTZ  NOT NULL,
  hits          INTEGER      NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);

-- Same protection as the other tables: the browser cannot read or change it directly.
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
