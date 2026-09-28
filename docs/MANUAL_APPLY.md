# Manual Outlook filing

Scheduled calls remain dry-run only: `supabase/schedule.sql` posts `{"apply": false}`, and the Edge Function rejects apply requests without `manual: true`.

## Review, then apply one small batch

1. Run a new manual preview with `manual: true`, `preview: true`, `apply: false`, a unique `run_key`, and `account_label` for the single account you intend to review. Omitting `account_label` previews all three configured accounts and explicitly reports disabled accounts.
2. Review the proposed sender, subject, and destination for the selected account. Only entries marked `in_apply_batch: true` can move in this first batch; the response includes a `preview_hash` for that exact batch and a top-level `preview_run_key` (the preview's `run_key`). It includes no message body or Graph message ID.
3. Enable `apply_enabled` for only the account you intend to test. It is a separate database gate; accounts remain disabled for filing by default.
4. Apply with a different unique `run_key`, the preview response's `preview_run_key`, account `account_label`, exact `preview_hash`, and `confirmation: "FILE REVIEWED PREVIEW"`.

The manual call verifies that `preview_run_key` identifies a finished manual preview with a complete stored result for the selected account (another account’s failure does not invalidate that result). It recalculates the candidate set and checks the preview hash before any move. The hash covers only the batch of up to five messages that can move (the entries marked `in_apply_batch: true`); deferred candidates outside that batch are not part of the hash and do not block apply. It aborts without moving mail if the scan is partial or any batch message's sender, subject, destination, or batch membership changed. It then rechecks each message's Inbox location, sender, subject, read state, flag state, and filing rule immediately before moving it.

Each apply call is limited to five messages in one personal Outlook account. A unique run key is claimed once in `organizer_runs`; repeat requests with that key are skipped. If a request stops partway through, already moved messages are no longer in Inbox and will not be selected by a later preview. Results report scanned, eligible, attempted, moved, skipped, failed, pending, unprocessed, and deferred counts for that account. `attempted` counts issued Graph move requests, not the batch size. The database stores counts, opaque run/account identifiers, and a preview digest; never subjects, sender addresses, bodies, or Graph message IDs.

Destination folders must already exist as unique top-level folders with the exact configured name. Missing, ambiguous, Inbox, Deleted Items, Trash, Junk, Drafts, Sent Items, or Outbox destinations fail closed. No message is deleted, unsubscribed, or sent.

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


## Remaining-review fixes: deployment boundary

The new journal migration must be applied before deploying the new handler. These
changes do not enable any account or change the scheduled request. Deployment and
live verification are separate, later steps. Run a fresh preview after deployment.
Only explicit `notFlagged` messages can file; missing, unknown, and completed flag
states remain for review. Manual preview/apply works with the other accounts disabled.

## Durable progress and recovery

Each manual apply acquires a persistent, exclusive account lease in
`organizer_apply_journal` before scanning. A different run key cannot bypass it.
Before each Graph move, the journal commits one pending intent. After HTTP 201,
it records the confirmed move before proceeding. Final result insertion, run
status, and lease release commit together. The journal remains the durable source
of progress if that final transaction fails.

Graph and Postgres cannot commit atomically. A timeout or unexpected move response
is **unknown**, not proof that the message stayed in Inbox. Processing stops with
`recovery_required`; the journal retains `pending = 1` and the lease stays held.
Likewise, a lost database acknowledgment stops processing even if the transaction
may have committed. The response's `moved` is the number of HTTP 201 responses this
worker received; consult the journal for acknowledged durable progress. The response
reports `pending: null` when a database acknowledgment was lost. Journal `prepared`
counts committed move intents, including a pending intent that might never have
reached Graph; response `attempted` counts move requests issued by this worker.
These intentionally distinct names avoid claiming an intent proves execution. A failed
final acknowledgment can return `recovery_required` even if finalization committed.
Do not blindly retry a move. There is no automatic lease expiry or takeover.

All claimed run keys, including failed and partial runs, are consumed permanently.
A new key is allowed only after the previous account lease has been safely closed,
followed by a new preview and review of the remaining messages.

Administrator recovery, performed later in Supabase SQL Editor:

1. Stop new invocations and ensure the old Edge Function worker has terminated.
   Do not unlock while a worker might still issue a Graph request. Disabling the
   account alone does not cancel a Graph request already in flight.
2. Inspect counts and lease state (replace the placeholder with the response's
   `run_id`, never with a credential):

   ```sql
   select r.id, r.slot_key, r.status, j.*
   from public.organizer_runs r
   left join public.organizer_apply_journal j on j.run_id = r.id
   where r.id = '<run UUID>';
   ```

3. If the journal is inactive, finalization already committed. Read the stored
   result; do not reconcile it again. If no journal exists, no move was authorized
   by this version; inspect the claimed run before starting a new preview.
4. If `pending = 1`, use the retained private preview and Outlook to verify whether
   the next batch message actually moved. If you cannot establish its outcome,
   keep the lease held. For `pending = 0`, confirmed counts are already durable.
5. As the database administrator, reconcile and abandon the rest of that batch:

   ```sql
   -- true = pending move verified successful; false = verified not moved.
   -- NULL = there is no pending intent. Never guess this value.
   select public.organizer_reconcile_apply('<run UUID>', NULL);
   ```

   This function cannot be called by anon, authenticated, or the Edge Function's
   service role. It records reconciled counts and releases the lease in one
   transaction. It never contacts Graph or replays the operation.

Keep private previews until the corresponding run is finalized or reconciled.

## Automated verification

`npm ci`, `npm run typecheck`, `npm test`, and `npm run test:python` run in CI.
Handler tests exercise the real handler and real migration/RPC SQL in embedded
Postgres (PGlite), with synthetic Graph and PostgREST HTTP responses. They cover
single-account operation, duplicate keys, concurrent applies, uncertain flags,
preview mismatches, pagination, partial scans, token rotation failure, and lost
move/audit acknowledgments. Database tests cover migration rollback, atomic
finalization, idempotent progress, RLS/grants, and administrative reconciliation.
These are not live Supabase/PostgREST or live Outlook tests.
