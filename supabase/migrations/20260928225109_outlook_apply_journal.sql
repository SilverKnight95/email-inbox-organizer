begin;

-- Counts and opaque run/account identifiers only. No mail metadata or Graph IDs.
create table public.organizer_apply_journal (
  run_id uuid primary key references public.organizer_runs(id),
  account_id uuid not null references public.organizer_accounts(id),
  active boolean not null default true,
  planned boolean not null default false,
  scanned integer not null default 0 check (scanned >= 0),
  eligible integer not null default 0 check (eligible >= 0),
  batch_size integer not null default 0 check (batch_size between 0 and 5),
  step integer not null default 0 check (step >= 0),
  prepared integer not null default 0 check (prepared >= 0),
  moved integer not null default 0 check (moved >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  failed integer not null default 0 check (failed >= 0),
  pending integer not null default 0 check (pending in (0, 1)),
  last_outcome text,
  updated_at timestamptz not null default now(),
  check (step = moved + skipped + failed),
  check (step + pending <= batch_size),
  check (prepared >= moved + pending and prepared <= step + pending),
  check (batch_size <= eligible and eligible <= scanned)
);
-- A different run key cannot bypass the account lease. No TTL takeover.
create unique index organizer_one_active_apply on public.organizer_apply_journal(account_id) where active;
alter table public.organizer_apply_journal enable row level security;
revoke all on public.organizer_apply_journal from public, anon, authenticated;
grant select, insert, update on public.organizer_apply_journal to service_role;

create function public.organizer_claim_run(p_slot text, p_preview boolean)
returns uuid language sql security invoker set search_path = '' as $$
  insert into public.organizer_runs(slot_key, status, preview)
  values (p_slot, 'running', p_preview)
  on conflict (slot_key) do nothing returning id;
$$;

create function public.organizer_begin_apply(p_run uuid, p_account uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.organizer_accounts where id = p_account
    and enabled and apply_enabled and provider = 'outlook' and role = 'personal'
    and label in ('personal-outlook-1', 'personal-outlook-2', 'personal-outlook-3'))
    or not exists (select 1 from public.organizer_runs where id = p_run
      and status = 'running' and not preview and slot_key like 'manual:%') then
    return false;
  end if;
  insert into public.organizer_apply_journal(run_id, account_id) values (p_run, p_account)
    on conflict do nothing;
  return found;
end;
$$;

create function public.organizer_plan_apply(p_run uuid, p_scanned integer, p_eligible integer, p_batch integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare j public.organizer_apply_journal;
begin
  select * into strict j from public.organizer_apply_journal where run_id = p_run for update;
  if not j.active or j.step <> 0 or j.pending <> 0 then raise exception 'inactive or started apply'; end if;
  if j.planned then
    if (j.scanned, j.eligible, j.batch_size) = (p_scanned, p_eligible, p_batch) then return; end if;
    raise exception 'apply plan changed';
  end if;
  if p_batch is null or p_batch < 0 then raise exception 'invalid plan'; end if;
  update public.organizer_apply_journal set planned = true, scanned = p_scanned,
    eligible = p_eligible, batch_size = p_batch, updated_at = now() where run_id = p_run;
end;
$$;

create function public.organizer_step_apply(p_run uuid, p_step integer, p_outcome text)
returns void language plpgsql security invoker set search_path = '' as $$
declare j public.organizer_apply_journal;
begin
  select * into strict j from public.organizer_apply_journal where run_id = p_run for update;
  if not j.active or not j.planned then raise exception 'inactive apply'; end if;
  -- Progress acknowledgments may be retried; Graph moves must never be retried.
  if p_step = j.step and p_outcome = j.last_outcome then return; end if;
  if p_step is null or p_step <> j.step + 1 or p_step > j.batch_size then raise exception 'unexpected step'; end if;
  if p_outcome = 'pending' then
    if j.pending = 1 then return; end if;
    update public.organizer_apply_journal set pending = 1, prepared = prepared + 1, updated_at = now()
      where run_id = p_run;
  elsif p_outcome = 'moved' and j.pending = 1 then
    update public.organizer_apply_journal set pending = 0, moved = moved + 1, step = p_step,
      last_outcome = p_outcome, updated_at = now() where run_id = p_run;
  elsif p_outcome in ('skipped', 'failed') and j.pending = 0 then
    update public.organizer_apply_journal set step = p_step,
      skipped = skipped + case when p_outcome = 'skipped' then 1 else 0 end,
      failed = failed + case when p_outcome = 'failed' then 1 else 0 end,
      last_outcome = p_outcome, updated_at = now() where run_id = p_run;
  else raise exception 'invalid apply transition';
  end if;
end;
$$;

create function public.organizer_finish_apply(p_run uuid, p_error text)
returns text language plpgsql security invoker set search_path = '' as $$
declare j public.organizer_apply_journal; terminal text; done boolean;
begin
  select * into strict j from public.organizer_apply_journal where run_id = p_run for update;
  if not j.active then
    select status into strict terminal from public.organizer_runs where id = p_run;
    return terminal;
  end if;
  if j.pending <> 0 then raise exception 'pending Graph outcome requires reconciliation'; end if;
  done := j.planned and j.batch_size > 0 and j.moved = j.batch_size and p_error is null;
  terminal := case when done then 'apply_complete' when j.moved > 0 then 'apply_partial' else 'failed' end;
  insert into public.organizer_run_results(run_id, account_id, mode, inbox_scanned, would_file, filed, complete, error, summary)
    values (p_run, j.account_id, 'apply', j.scanned, j.eligible, j.moved, done, p_error,
      jsonb_build_object('prepared', j.prepared, 'moved', j.moved, 'skipped', j.skipped,
        'failed', j.failed, 'pending', j.pending, 'deferred', j.eligible - j.batch_size,
        'unprocessed', j.batch_size - j.step));
  update public.organizer_runs set status = terminal, finished_at = now() where id = p_run;
  update public.organizer_apply_journal set active = false, updated_at = now() where run_id = p_run;
  return terminal;
end;
$$;

-- ADMIN ONLY. Before using this, stop invocations and confirm the old worker has
-- terminated. Verify the pending message in Outlook using the retained preview.
-- No automatic unlock/replay: Graph and Postgres cannot commit atomically.
create function public.organizer_reconcile_apply(p_run uuid, p_pending_moved boolean)
returns text language plpgsql security invoker set search_path = '' as $$
declare j public.organizer_apply_journal;
begin
  select * into strict j from public.organizer_apply_journal where run_id = p_run for update;
  if not j.active then raise exception 'already finalized'; end if;
  if j.pending = 1 then
    if p_pending_moved is null then raise exception 'verify pending outcome first'; end if;
    if p_pending_moved then
      perform public.organizer_step_apply(p_run, j.step + 1, 'moved');
    else
      -- Verified NOT moved; abandon this prepared operation, do not replay it.
      update public.organizer_apply_journal set pending = 0,
        failed = failed + 1, step = step + 1, last_outcome = 'failed', updated_at = now()
        where run_id = p_run;
    end if;
  elsif p_pending_moved is not null then raise exception 'no pending outcome';
  end if;
  return public.organizer_finish_apply(p_run, 'manually reconciled; remaining batch abandoned');
end;
$$;

revoke all on function public.organizer_claim_run(text, boolean), public.organizer_begin_apply(uuid, uuid),
  public.organizer_plan_apply(uuid, integer, integer, integer), public.organizer_step_apply(uuid, integer, text),
  public.organizer_finish_apply(uuid, text), public.organizer_reconcile_apply(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.organizer_claim_run(text, boolean), public.organizer_begin_apply(uuid, uuid),
  public.organizer_plan_apply(uuid, integer, integer, integer), public.organizer_step_apply(uuid, integer, text),
  public.organizer_finish_apply(uuid, text) to service_role;
revoke all on function public.organizer_reconcile_apply(uuid, boolean) from service_role;
commit;
