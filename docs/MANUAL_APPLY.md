# Manual Outlook filing

Scheduled calls remain dry-run only: `supabase/schedule.sql` posts `{"apply": false}`, and the Edge Function rejects apply requests without `manual: true`.

## Review, then apply one small batch

1. Run a new manual preview with `manual: true`, `preview: true`, `apply: false`, and a unique `run_key`.
2. Review every proposed sender, subject, and destination for the selected account. The response includes a `preview_hash` for that account. It includes no message body or Graph message ID.
3. Enable `apply_enabled` for only the account you intend to test. It is a separate database gate; accounts remain disabled for filing by default.
4. Apply with a different unique `run_key`, the preview's `preview_run_key`, account `account_label`, exact `preview_hash`, and `confirmation: "FILE REVIEWED PREVIEW"`.

The manual call recalculates the candidate set and checks the preview hash before any move. It aborts without moving mail if the scan is partial or any candidate sender, subject, destination, or set membership changed. It then rechecks each message's Inbox location, read state, flag state, and filing rule immediately before moving it.

Each apply call is limited to five messages in one personal Outlook account. A unique run key is claimed once in `organizer_runs`; repeat requests with that key are skipped. If a request stops partway through, already moved messages are no longer in Inbox and will not be selected by a later preview. Results report scanned, eligible, attempted, moved, skipped, failed, and deferred counts for that account. The database stores counts only.

Destination folders must already exist as unique top-level folders with the exact configured name. Missing, ambiguous, Inbox, Deleted Items, Trash, Junk, Drafts, or Sent Items destinations fail closed. No message is deleted, unsubscribed, or sent.

Apply request body shape:

```json
{
  "manual": true,
  "apply": true,
  "run_key": "apply001",
  "preview_run_key": "preview001",
  "account_label": "personal-outlook-1",
  "preview_hash": "<64-character hash from the reviewed preview>",
  "confirmation": "FILE REVIEWED PREVIEW"
}
```

The hash and confirmation are not credentials. Keep the preview response private because sender and subject are private mail metadata.
