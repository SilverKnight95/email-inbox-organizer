-- Reject NULL account fingerprints and serialize authorization with account edits.
-- Reauthorization always restores the documented dry-run-only state.

create or replace function organizer_store_refresh_token_by_label(
  account_label text,
  token text,
  account_key text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  account_id uuid;
  expected text;
begin
  if account_label not in ('personal-outlook-1', 'personal-outlook-2', 'personal-outlook-3') then
    raise exception 'account not allowed';
  end if;
  select id, organizer_accounts.account_key into account_id, expected
  from organizer_accounts
  where label = account_label and provider = 'outlook' and role = 'personal'
  for update;
  if account_id is null or expected is null or expected = ''
     or account_key is null or expected is distinct from account_key then
    raise exception 'account key does not match this slot';
  end if;
  perform organizer_store_refresh_token(account_id, token);
  update organizer_accounts
    set enabled = true, apply_enabled = false
    where id = account_id;
end;
$$;

revoke all on function organizer_store_refresh_token_by_label(text, text, text) from public, anon, authenticated;
grant execute on function organizer_store_refresh_token_by_label(text, text, text) to service_role;
