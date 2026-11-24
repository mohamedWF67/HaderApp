-- =====================================================================
-- HaderApp (Group 40) - Step 2: shared profiles + Registration Service tables
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
-- =====================================================================

-- 1) PROFILES (shared by all three services)
-- Supabase Auth keeps logins in auth.users. This table adds each user's name and ROLE.
-- The role is NOT taken from the sign-up form, so nobody can make themselves an organizer.
CREATE TABLE public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL DEFAULT '',
  role        VARCHAR(20)  NOT NULL DEFAULT 'attendee'
                CHECK (role IN ('organizer', 'attendee')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Every new sign-up automatically gets a profile with role = attendee.
-- Organizers are promoted by hand (see the note at the end).
CREATE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, name)
  VALUES (NEW.id, COALESCE(LEFT(NEW.raw_user_meta_data ->> 'name', 100), ''));
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2) WORKSHOPS (Registration Service - Nourhan)
CREATE TABLE public.workshops (
  workshop_id    SERIAL PRIMARY KEY,
  title          VARCHAR(100)  NOT NULL,
  description    VARCHAR(1000) NOT NULL DEFAULT '',
  workshop_date  TIMESTAMPTZ   NOT NULL,
  total_seats    INTEGER       NOT NULL CHECK (total_seats BETWEEN 1 AND 1000),
  seats_left     INTEGER       NOT NULL CHECK (seats_left >= 0),
  organizer_id   UUID          NOT NULL REFERENCES public.profiles(id),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Optional: after this time nobody can register (NULL = open until it starts). See 003_registration_deadline.sql
  registration_deadline TIMESTAMPTZ,
  CONSTRAINT seats_left_not_above_total CHECK (seats_left <= total_seats),
  CONSTRAINT deadline_not_after_start CHECK (registration_deadline IS NULL OR registration_deadline <= workshop_date)
);

-- 3) REGISTRATIONS (Registration Service - Nourhan)
-- Cancelling deletes the row, so the attendee can register again later.
CREATE TABLE public.registrations (
  registration_id  SERIAL PRIMARY KEY,
  workshop_id      INTEGER     NOT NULL REFERENCES public.workshops(workshop_id) ON DELETE CASCADE,
  attendee_id      UUID        NOT NULL REFERENCES public.profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_registration_per_attendee UNIQUE (workshop_id, attendee_id)
);

CREATE INDEX idx_workshops_organizer     ON public.workshops(organizer_id);
CREATE INDEX idx_registrations_attendee  ON public.registrations(attendee_id);

-- 3b) WAITLIST (Registration Service - Nourhan): people queueing for a full workshop.
-- (Also available on its own in 002_waitlist.sql for databases created before it existed.)
CREATE TABLE public.waitlist (
  waitlist_id  SERIAL PRIMARY KEY,
  workshop_id  INTEGER     NOT NULL REFERENCES public.workshops(workshop_id) ON DELETE CASCADE,
  attendee_id  UUID        NOT NULL REFERENCES public.profiles(id),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_place_per_attendee UNIQUE (workshop_id, attendee_id)
);
CREATE INDEX idx_waitlist_queue    ON public.waitlist(workshop_id, joined_at, waitlist_id);
CREATE INDEX idx_waitlist_attendee ON public.waitlist(attendee_id);

-- 3c) NOTIFICATIONS (Registration Service - Nourhan). Also in 004_notifications.sql.
-- One row = one message for one user (shown under the bell on the website).
CREATE TABLE public.notifications (
  notification_id  SERIAL PRIMARY KEY,
  user_id          UUID         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- If the workshop is deleted later, the message stays (it already contains the title).
  workshop_id      INTEGER      REFERENCES public.workshops(workshop_id) ON DELETE SET NULL,
  type             VARCHAR(40)  NOT NULL,
  message          VARCHAR(300) NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  read_at          TIMESTAMPTZ
);

CREATE INDEX idx_notifications_user ON public.notifications(user_id, created_at DESC);

-- The scheduled checks run every minute: this makes sure each scheduled message is
-- created only once per person and workshop, however many times the check runs.
CREATE UNIQUE INDEX one_scheduled_notice
  ON public.notifications(user_id, workshop_id, type)
  WHERE type IN ('registration_closed', 'workshop_reminder', 'waitlist_expired');

-- 3d) RATE LIMITS (Registration Service - Nourhan). Also in 005_rate_limits.sql.
CREATE TABLE public.rate_limits (
  bucket        VARCHAR(100) NOT NULL,
  window_start  TIMESTAMPTZ  NOT NULL,
  hits          INTEGER      NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);

-- 4) SECURITY: Row Level Security ON, with no policies.
-- This blocks the browser (Supabase public key) from reading or changing these tables
-- directly. Only our backend, which connects with the database connection string, can.
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshops     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits   ENABLE ROW LEVEL SECURITY;

-- 5) SECURITY: block direct calls to the automatic sign-up function (Security Advisor fix)
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- To make someone an organizer (run separately, after they have signed up):
--   UPDATE public.profiles SET role = 'organizer'
--   WHERE id = (SELECT id FROM auth.users WHERE email = 'organizer@example.com');
-- ---------------------------------------------------------------------
