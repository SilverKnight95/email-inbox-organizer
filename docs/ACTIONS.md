# When mail is filed, trashed, or left

## Scheduled sort

Command shape: `python3 scripts/sort_all.py --apply`

Runs Monday and Thursday at 8:00 a.m. America/Chicago (`0 8 * * 1,4`).

Filed, by moving to an Outlook folder or adding a Gmail label and removing `INBOX`:

- The message is read.
- It is not flagged.
- The subject does not start with `Inbox digest`.
- A rule matches.
- If the subject matches the global safety pattern (password, verification, invoice, bill, fraud, settlement, and the rest of `global_exclude_subject`), it is filed only when that rule sets `bypass_safety`.

Left in the inbox:

- Unread mail, always.
- Flagged mail.
- Mail that matches no rule. On Gmail, unmatched read mail may still be labeled by category: Promotions become Newsletters, Social becomes Entertainment, a human Personal message becomes Personal, and other Updates become Updates. That fallback does not apply to unread mail.
- School, government, health, security, and billing mail unless a confirmed rule names that folder and the message is read.

Not done by the scheduled sort: delete, trash, unsubscribe, send, or connect a new account.

## Unsubscribe

Manual only.

Scanned: Gmail promotions, updates, and social, excluding the spam folder.

Opted out when the message has a `List-Unsubscribe` header and is not protected:

- One-click: HTTP POST `List-Unsubscribe=One-Click` when `List-Unsubscribe-Post` says one-click.
- Mailto: an unsubscribe message is sent only after an explicit request to opt out. This repository does not send that mail.

Not opted out:

- Anything already in Spam. Those senders are not told the address is active.
- `.gov`, `.edu`, `.mil`, school domains, GitHub, PayPal, Google account mail, ID.me, IRS, Social Security, student aid, and Marketplace mail.
- Subjects that are verification codes, passwords, sign-in alerts, invoices, statements, bills, shipping notices, or order confirmations.

## Spam review and trash

Manual only, and only after opt-out results exist locally.

A message is moved to Gmail Trash or Outlook Deleted Items only when all of these are true:

- The sender's opt-out status is success. Failed, blocked, link-only, and unknown lists are not deleted.
- The sender is not flagged as shipping, order, billing, policy, or security mail.
- The folder is a marketing folder: Newsletters, Finance Newsletters, Entertainment, Updates, Promotions, or Social.
- The subject does not look like an order, shipment, invoice, bill, payment, receipt, password, verification, security alert, appointment, claim, student, loan, or policy notice.

Left for review, not deleted:

- The same sender in School, Legal, Security, Orders, Important, Priority, Health, Finance, Personal, GitHub, Tech, or Local.
- Gmail `CATEGORY_UPDATES`, even if the sender opted out.
- Any subject containing a hold phrase.
- UPS and other shipping addresses, policy-notice addresses, and order or billing local-parts.
- Lists whose opt-out was blocked or failed.

Trash and Deleted Items are recoverable. This policy does not permanently purge mail.

The scheduled sort does not trash mail.
