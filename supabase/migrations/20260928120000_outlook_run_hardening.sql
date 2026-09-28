-- Visible incomplete runs, and private replacement-token storage.
-- Does not enable filing. Does not store mailbox contents.

alter table organizer_runs drop constraint if exists organizer_runs_status_check;
alter table organizer_runs
  add constraint organizer_runs_status_check
  check (status in ('running', 'dry_run_complete', 'incomplete', 'failed'));

alter table organizer_run_results
  add column if not exists complete boolean not null default false;

create or replace function organizer_store_refresh_token(account_id uuid, token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_id uuid;
begin
  if token is null or length(token) = 0 then
    raise exception 'token missing';
  end if;
  select token_secret_id into secret_id
  from organizer_accounts
  where id = account_id and provider = 'outlook' and role = 'personal';
  if not found then
    raise exception 'account not found';
  end if;
  if secret_id is null then
    secret_id := vault.create_secret(token, 'outlook-refresh-' || account_id::text);
    update organizer_accounts
      set token_secret_id = secret_id
      where id = account_id;
  else
    perform vault.update_secret(secret_id, token);
  end if;
end;
$$;

revoke all on function organizer_store_refresh_token(uuid, text) from public, anon, authenticated;
grant execute on function organizer_store_refresh_token(uuid, text) to service_role;
