# Email Inbox Organizer

Policy and configuration examples for sorting personal mail, opting out of marketing lists, and trashing only marketing whose opt-out succeeded.

This repository does not contain mailbox contents, sender address lists, contact lists, account identifiers, or credentials. Those stay in the private agent workspace.

## Boundaries

- Four personal mailboxes are configured locally. A school mailbox is not connected and must not be added. The school blocked third-party access.
- Unread mail stays in the inbox. Flagged mail stays in the inbox.
- School, government, orders, bills, shipping, health, security, and uncertain mail are protected.
- Nothing in this repository sends, moves, or deletes mail by itself.

## What each run is allowed to do

| Run | Cadence | Files read mail | Leaves unread | Sends mail | Trashes mail |
|---|---|---|---|---|---|
| Scheduled sort | Monday and Thursday, 8:00 a.m. America/Chicago | Yes, rules only | Yes | No | No |
| Unsubscribe | Manual, after an explicit request | No | Yes | Only list-unsubscribe messages, and only when requested | No |
| Spam review | Manual, after an explicit request | No | Yes | No | Only marketing from lists whose opt-out succeeded |

See [docs/ACTIONS.md](docs/ACTIONS.md) for the exact leave / file / trash rules.

## Layout

- `src/email_inbox_organizer/` — decisions that can be tested with no mailbox access
- `config/rules.example.json` — synthetic rules showing the schema
- `config/domain_and_subject_rules.json` — real domain and subject rules, with every sender address removed
- `config/accounts.example.json` — four personal slots, placeholders only
- `config/schedule.example.json` — the live Monday/Thursday schedule, as documentation
- `tests/fixtures/` — synthetic messages only

## Run the tests

```bash
python3 tests/test_policies.py
```

No network and no mail account is required.

## What still depends on Gamut

Live filing, unsubscribe delivery, and trash need Gamut's connected-account proxy and local account ids. Do not commit those values. The Monday/Thursday job is a Gamut scheduled task, not a cron job in this repo. One-click unsubscribe POSTs go to each list's own HTTPS endpoint and do not need Gamut once a `List-Unsubscribe` URL is already in hand. Collecting those URLs from a mailbox does need the Gmail connection.

Do not commit `accounts.json`, logs, digests, unsubscribe results, or `.env`.
