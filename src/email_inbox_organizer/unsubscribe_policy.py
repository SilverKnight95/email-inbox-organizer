"""Who may be opted out. The spam folder is never unsubscribed."""

PROTECTED_SUFFIXES = (
    ".gov",
    ".edu",
    ".mil",
    "dallascollege.edu",
    "dcccd.edu",
    "github.com",
    "paypal.com",
    "accounts.google.com",
    "accountprotection.microsoft.com",
    "id.me",
    "gamutagents.com",
    "ssa.gov",
    "studentaid.gov",
    "irs.gov",
    "healthcare.gov",
)

TRANSACTIONAL_SUBJECT = (
    "verification code",
    "one-time",
    "passcode",
    "password",
    "sign-in",
    "sign in",
    "security alert",
    "fraud",
    "invoice",
    "your statement",
    "statement is ready",
    "bill is ready",
    "shipped:",
    "delivered:",
    "order confirmation",
    "your order",
)

TRANSACTIONAL_LOCAL = (
    "shipment-tracking",
    "order-update",
    "auto-confirm",
    "ship-confirm",
    "account-security",
)


def protected(email, subject):
    domain = email.split("@")[-1] if "@" in email else email
    local = email.split("@")[0] if "@" in email else email
    if any(domain == suffix.lstrip(".") or domain.endswith(suffix) for suffix in PROTECTED_SUFFIXES):
        return True
    if any(part in local for part in TRANSACTIONAL_LOCAL):
        return True
    subject_l = (subject or "").lower()
    return any(phrase in subject_l for phrase in TRANSACTIONAL_SUBJECT)


def may_unsubscribe(email, subject, in_spam):
    if in_spam:
        return False
    return not protected(email, subject)
