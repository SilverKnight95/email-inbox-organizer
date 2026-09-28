# Setup

This repo documents the organizer. It does not connect accounts and it does not install the live schedule.

## Local config

Copy the examples and fill them outside git:

```bash
cp config/accounts.example.json accounts.json
cp config/rules.example.json rules.json
```

`accounts.json` is gitignored. Use the connected-account id from the agent environment. Do not put that file, OAuth tokens, or proxy tokens in git.

The live agent already has four personal accounts and a Monday/Thursday 8:00 a.m. America/Chicago task. Exporting this repo does not change that task.

## Rules

`config/domain_and_subject_rules.json` is the publishable part of the live rules: domain, domain-suffix, and subject matches. Sender-address rules are intentionally absent.

Add sender rules only in the private workspace copy of `rules.json`. A sender rule looks like the synthetic entry in `config/rules.example.json`.

`never_move_unread` must stay true.

## Schedule

The live task is documented in `config/schedule.example.json`. Recreating it is a Gamut `schedule_task` call, not something this repo does. The prompt must say: file read mail only, leave unread mail, do not delete, do not send, do not add a school mailbox.

## Unsubscribe and trash

Do not run those against a live mailbox from this repository unless the account owner has asked for that pass. The policy functions can be imported and tested with fixtures. Applying them needs the Gamut Gmail and Outlook proxy.
