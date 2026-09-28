-- Private storage for three personal Outlook accounts.
-- No school mailbox. No Gmail. Tokens stay in Vault.
-- Live filing is disabled: apply_enabled defaults to false.

create table if not exists organizer_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  provider text not null default 'outlook' check (provider = 'outlook'),
  role text not null default 'personal' check (role = 'personal'),
  tenant text not null default 'consumers' check (tenant = 'consumers'),
  token_secret_id uuid,
  enabled boolean not null default false,
  apply_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint organizer_accounts_label_not_school check (label !~* 'school|college|dallas')
);

create table if not exists organizer_runs (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null unique,
  status text not null check (status in ('running', 'dry_run_complete', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists organizer_run_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references organizer_runs (id),
  account_id uuid not null references organizer_accounts (id),
  mode text not null default 'dry_run' check (mode = 'dry_run'),
  inbox_scanned integer not null default 0,
  would_file integer not null default 0,
  left_unread integer not null default 0,
  left_flagged integer not null default 0,
  left_for_review integer not null default 0,
  filed integer not null default 0 check (filed = 0),
  error text,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, account_id)
);

alter table organizer_accounts enable row level security;
alter table organizer_runs enable row level security;
alter table organizer_run_results enable row level security;

revoke all on organizer_accounts, organizer_runs, organizer_run_results from anon, authenticated;

insert into organizer_accounts (label)
values ('personal-outlook-1'), ('personal-outlook-2'), ('personal-outlook-3')
on conflict (label) do nothing;

create or replace function organizer_refresh_token(account_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_id uuid;
  token text;
begin
  select token_secret_id into secret_id
  from organizer_accounts
  where id = account_id and provider = 'outlook' and role = 'personal';
  if secret_id is null then
    raise exception 'token not found';
  end if;
  select decrypted_secret into token
  from vault.decrypted_secrets
  where id = secret_id;
  return token;
end;
$$;

revoke all on function organizer_refresh_token(uuid) from public, anon, authenticated;
grant execute on function organizer_refresh_token(uuid) to service_role;
