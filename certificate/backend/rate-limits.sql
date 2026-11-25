-- Rate limiting for the Certificate Service (proposal 6.2). Run once in the Supabase SQL editor.
-- One row per caller + route + minute. Only the certificate service can use it.
CREATE TABLE IF NOT EXISTS public.certificate_rate_limits (
  bucket       VARCHAR(120) NOT NULL,     -- e.g. cert:verify:154.177.86.143
  window_start TIMESTAMPTZ  NOT NULL,     -- the minute being counted
  hits         INTEGER      NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);

-- Browsers / Supabase's public API cannot read or change it.
ALTER TABLE public.certificate_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.certificate_rate_limits FROM anon, authenticated;

-- The certificate service may count and clean up its own counters, nothing else.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.certificate_rate_limits TO certificate_service;
DROP POLICY IF EXISTS certificate_service_rate_limits ON public.certificate_rate_limits;
CREATE POLICY certificate_service_rate_limits ON public.certificate_rate_limits
  FOR ALL TO certificate_service USING (true) WITH CHECK (true);
