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
- `ORGANIZER_INVOKE_SECRET`

The Azure app is a confidential client. Redirect URI: `http://127.0.0.1:8787/callback`. Scopes: `offline_access`, `User.Read`, and `Mail.ReadWrite`. Tenant: `consumers`.

## 3. Deploy the function

```bash
supabase functions deploy outlook-sort --no-verify-jwt
```

`--no-verify-jwt` is required because the scheduler sends a shared secret, not a Supabase user JWT. The function itself rejects any request that does not have `Authorization: Bearer $ORGANIZER_INVOKE_SECRET`. Set that secret with the other function secrets. Do not invoke the function with `{"apply": true}`.

## 4. Authorize each account

Repeat for `personal-outlook-1`, `personal-outlook-2`, and `personal-outlook-3`.

```bash
python3 scripts/outlook_authorize.py \
  --label personal-outlook-1 \
  --client-id "$AZURE_CLIENT_ID"
```

Open the printed URL and sign in to that personal Outlook account. Copy the redirect URL from the browser. Do not save it in this repo. Then, with `AZURE_CLIENT_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` set in the environment:

```bash
python3 scripts/outlook_authorize.py \
  --complete \
  --label personal-outlook-1 \
  --client-id "$AZURE_CLIENT_ID" \
  --callback-url "$CALLBACK_URL"
```

The script checks `state`, exchanges the code, and stores the refresh token through `organizer_store_refresh_token_by_label`. It enables that personal account and leaves `apply_enabled` false. Success prints only `{"label":"personal-outlook-1","stored":true,"apply_enabled":false}`. It does not print the token.

## 5. Review a dry run

Call the function once, outside the schedule, only after the three tokens are stored. Use a unique manual run key. This path does not require the Chicago 8:00 a.m. window and cannot enable filing:

```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/outlook-sort" \
  -H "Authorization: Bearer $ORGANIZER_INVOKE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"manual": true, "apply": false, "run_key": "review001"}'
```

The run key is stored as `manual:review001`. A second call with the same key is rejected. `{"apply": true}` is rejected even on this path.

A complete run has status `dry_run_complete` and one result per account with `complete = true` and `filed = 0`. `incomplete` means a mailbox was not fully scanned. `failed` means a token, rotation save, or database write failed. Results are counts only.

## 6. Leave the schedule inactive

`supabase/schedule.sql` is the Monday/Thursday 8:00 a.m. America/Chicago checker. Do not run it until the dry run above has been reviewed. It posts `{"apply": false}` and does not file mail.

Do not set `apply_enabled`. Do not change the Gamut agent.
