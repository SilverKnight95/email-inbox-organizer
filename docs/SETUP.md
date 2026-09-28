# Setup

Three personal Outlook accounts. Gmail is not used. Do not connect a school mailbox. Do not activate the schedule or live filing until a dry run has been reviewed. This does not change the Gamut agent.

## 1. Database

Apply the migrations in order, before deploying the function:

```bash
supabase db push
```

That creates `organizer_accounts`, `organizer_runs`, and `organizer_run_results`, plus Vault helpers. Three disabled rows are inserted: `personal-outlook-1`, `personal-outlook-2`, and `personal-outlook-3`. `apply_enabled` is false.

## 2. Function secrets

Set these in Supabase, not in git:

- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The Azure app is a confidential client. Redirect URI: `http://127.0.0.1:8787/callback`. Scopes: `offline_access`, `User.Read`, and `Mail.ReadWrite`. Tenant: `consumers`.

## 3. Deploy the function

```bash
supabase functions deploy outlook-sort --no-verify-jwt
```

Do not invoke it with `{"apply": true}`. The function rejects that.

## 4. Authorize each account

Repeat for `personal-outlook-1`, `personal-outlook-2`, and `personal-outlook-3`.

```bash
python3 scripts/outlook_authorize.py \
  --label personal-outlook-1 \
  --client-id "$AZURE_CLIENT_ID"
```

Open the printed URL and sign in to that personal Outlook account. Microsoft redirects to the callback. Then:

```bash
python3 scripts/outlook_authorize.py \
  --label personal-outlook-1 \
  --client-id "$AZURE_CLIENT_ID" \
  --callback-url "http://127.0.0.1:8787/callback?code=CODE&state=STATE"
```

The script checks `state` and refuses a mismatch. Exchange the code with `exchange_code` from `graph_auth.py`. Store the refresh token with Vault, not in a file in this repo:

```sql
select organizer_store_refresh_token(
  (select id from organizer_accounts where label = 'personal-outlook-1'),
  'PASTE_REFRESH_TOKEN'
);
update organizer_accounts
  set enabled = true
  where label = 'personal-outlook-1';
```

Leave `apply_enabled` false. Delete any local copy of the token after the Vault write. If Microsoft later returns a replacement refresh token, the function saves it with `organizer_store_refresh_token` before that account can succeed.

## 5. Review a dry run

Call the function once, outside the schedule, only after the three tokens are stored:

```json
{"apply": false}
```

A complete run has status `dry_run_complete` and one result per account with `complete = true` and `filed = 0`. `incomplete` means a mailbox was not fully scanned. `failed` means a token, rotation save, or database write failed. Results are counts only.

## 6. Leave the schedule inactive

`supabase/schedule.sql` is the Monday/Thursday 8:00 a.m. America/Chicago checker. Do not run it until the dry run above has been reviewed. It posts `{"apply": false}` and does not file mail.

Do not set `apply_enabled`. Do not change the Gamut agent.
