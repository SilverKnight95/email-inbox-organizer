# Independent Outlook sorter

This version sorts three personal Outlook accounts through Microsoft Graph. It does not use the Gamut mailbox proxy. Gmail is not part of this version. A school mailbox is not connected and the database rejects a school or college label.

## Authorization

Personal Outlook accounts use the `consumers` tenant.

1. Register an Azure app with a confidential client secret.
2. Redirect URI points at your own callback, not at this repository.
3. Scopes are `offline_access`, `User.Read`, and `Mail.ReadWrite`.
4. `authorize_url` never includes the client secret.
5. Exchange the code, then store only the refresh token in Supabase Vault.
6. Put the Azure client id and secret in Supabase function secrets, not in git.

The edge function refreshes the access token on each run and does not return it.

## Dry run

`outlook_adapter.dry_run_account` and the `outlook-sort` function only send Graph `GET` requests. Counts are:

- would file
- left unread
- left flagged
- left for review

Results do not store subjects, message ids, or addresses. `filed` is constrained to 0.

Live filing stays disabled. `apply_filing` raises unless a reviewed flag is passed, and the scheduled function rejects `"apply": true`. Accounts with `apply_enabled` are skipped rather than filed.

## Schedule

Monday and Thursday at 8:00 a.m. America/Chicago. The prepared cron in `supabase/schedule.sql` runs hourly and the function exits unless Chicago local time is in that window. A unique `slot_key` such as `2026-09-28T08` stops a second run in the same window. The scheduled body is `{"apply": false}`.

The job does not unsubscribe, send mail, or trash messages.

## Protected mail

Unread and flagged mail stay in the inbox. Mail that matches no rule stays for review. School, government, orders, bills, shipping, health, and security messages are not trashed by this version. Confirmed read-mail rules may still report a Security or School folder in `would_file`; that is a dry-run count only until filing is reviewed and explicitly enabled.
