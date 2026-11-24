-- =====================================================================
-- HaderApp (Group 40) - Step 5: in-app notifications (Registration Service - Nourhan)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.  Safe to run again.
-- =====================================================================

-- One row = one message for one user (shown under the bell on the website).
CREATE TABLE IF NOT EXISTS public.notifications (
  notification_id  SERIAL PRIMARY KEY,
  user_id          UUID         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- If the workshop is deleted later, the message stays (it already contains the title).
  workshop_id      INTEGER      REFERENCES public.workshops(workshop_id) ON DELETE SET NULL,
  type             VARCHAR(40)  NOT NULL,
  message          VARCHAR(300) NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  read_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, created_at DESC);

-- The scheduled checks run every minute: this makes sure each scheduled message is
-- created only once per person and workshop, however many times the check runs.
CREATE UNIQUE INDEX IF NOT EXISTS one_scheduled_notice
  ON public.notifications(user_id, workshop_id, type)
  WHERE type IN ('registration_closed', 'workshop_reminder', 'waitlist_expired');

-- Same protection as the other tables: the browser cannot read or change it directly.
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
