-- Data API table privileges for the private Edge Function only.
-- SQL Editor grants are recorded here so a fresh deployment works as well.
grant select on public.organizer_accounts to service_role;
grant select, insert, update on public.organizer_runs to service_role;
grant select, insert on public.organizer_run_results to service_role;
