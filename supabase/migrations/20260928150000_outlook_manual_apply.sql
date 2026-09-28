-- Allow only an explicitly requested manual apply run to record real filing.
-- The scheduled function still sends apply=false and cannot enter this path.

alter table organizer_runs
  drop constraint if exists organizer_runs_status_check;

alter table organizer_runs
  add constraint organizer_runs_status_check
  check (status in ('running', 'dry_run_complete', 'incomplete', 'failed', 'apply_complete', 'apply_partial'));

alter table organizer_runs
  add column if not exists preview boolean not null default false;

alter table organizer_run_results
  drop constraint if exists organizer_run_results_mode_check;

alter table organizer_run_results
  add constraint organizer_run_results_mode_check
  check (mode in ('dry_run', 'apply'));

alter table organizer_run_results
  drop constraint if exists organizer_run_results_filed_check;

alter table organizer_run_results
  add constraint organizer_run_results_filed_check
  check (filed >= 0);
