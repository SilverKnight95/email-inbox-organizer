# Email Inbox Organizer

Independent dry-run sorter for three personal Outlook accounts. It uses Microsoft Graph, not the Gamut mailbox proxy.

This repository does not contain mailbox contents, sender address lists, contact lists, account identifiers, or credentials.

## Boundaries

- Three personal Outlook accounts only. Gmail is not part of this version.
- A school mailbox is not connected and cannot be stored.
- The scheduled job is a dry run. Live filing stays disabled until a reviewed dry run.
- Unread and flagged mail stay in the inbox.
- Protected or uncertain mail stays for review. The job does not unsubscribe, send, or trash.
- The Gamut agent and its schedule are unchanged.

## Layout

- `src/email_inbox_organizer/` — filing decisions, Graph pagination, token rotation, and run status
- `config/accounts.example.json` — three personal Outlook placeholders
- `config/rules.example.json` — synthetic rules
- `config/domain_and_subject_rules.json` — domain and subject rules, with sender addresses removed
- `supabase/functions/outlook-sort` — scheduled dry run
- `supabase/schedule.sql` — prepared cron, not activated
- `docs/SETUP.md` — authorization callback and deployment order
- `tests/fixtures/` — synthetic messages only

## Tests

```bash
python3 tests/test_outlook_independent.py
python3 tests/test_policies.py
```

No network and no mail account is required.
