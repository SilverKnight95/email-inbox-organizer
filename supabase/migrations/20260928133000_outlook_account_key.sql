-- Bind each personal Outlook slot to a safe account key before a token can be stored.
-- The key is a fingerprint, not an email address. Live filing stays disabled.

alter table organizer_accounts
  add column if not exists account_key text;

alter table organizer_accounts
  drop constraint if exists organizer_accounts_account_key_unique;

alter table organizer_accounts
  add constraint organizer_accounts_account_key_unique unique (account_key);

drop function if exists organizer_store_refresh_token_by_label(text, text);

create or replace function organizer_expected_account_key(account_label text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  expected text;
begin
  if account_label not in ('personal-outlook-1', 'personal-outlook-2', 'personal-outlook-3') then
    raise exception 'account not allowed';
  end if;
  select account_key into expected
  from organizer_accounts
  where label = account_label and provider = 'outlook' and role = 'personal';
  return expected;
end;
$$;

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
  where label = account_label and provider = 'outlook' and role = 'personal';
  if account_id is null or expected is null or expected <> account_key then
    raise exception 'account key does not match this slot';
  end if;
  perform organizer_store_refresh_token(account_id, token);
  update organizer_accounts
    set enabled = true
    where id = account_id and apply_enabled = false;
end;
$$;

revoke all on function organizer_expected_account_key(text) from public, anon, authenticated;
revoke all on function organizer_store_refresh_token_by_label(text, text, text) from public, anon, authenticated;
grant execute on function organizer_expected_account_key(text) to service_role;
grant execute on function organizer_store_refresh_token_by_label(text, text, text) to service_role;
