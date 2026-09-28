"""Decide whether an already opted-out marketing message may be trashed."""

HOLD_FOLDERS = {
    "school",
    "legal",
    "security",
    "orders",
    "important",
    "priority",
    "health",
    "finance",
    "personal",
    "github",
    "tech",
    "local",
    "sent items",
    "drafts",
    "deleted items",
    "junk email",
    "trash",
    "spam",
    "sent",
    "draft",
}

MARKETING_FOLDERS = {
    "newsletters",
    "finance newsletters",
    "entertainment",
    "updates",
    "category_promotions",
    "category_social",
    "inbox",
}

HOLD_SUBJECT = (
    "order",
    "shipped",
    "delivered",
    "tracking",
    "invoice",
    "statement",
    "bill",
    "payment",
    "password",
    "passcode",
    "verify",
    "verification",
    "sign-in",
    "sign in",
    "security",
    "fraud",
    "student",
    "financial aid",
    "dallas college",
    "social security",
    "claim",
    "appointment",
    "prescription",
    "lab result",
    "policy",
    "agreement",
    "terms of",
    "warranty",
    "tuition",
    "nelnet",
    "loan",
    "one-time",
    "receipt",
)

# Opt-out may have succeeded, but these addresses are not clearly marketing.
FLAGGED_LOCAL_PARTS = ("order", "shipment", "tracking", "billing", "security")


def flagged_sender(email):
    local = email.split("@")[0] if "@" in email else email
    domain = email.split("@")[-1] if "@" in email else ""
    if domain in {"ups.com", "upsemail.com"} or domain.endswith(".ups.com"):
        return True
    if "policyemail" in local:
        return True
    return any(part in local for part in FLAGGED_LOCAL_PARTS)


def review(folder, subject, opt_out_status, email=""):
    """opt_out_status is success, failed, or unknown."""
    if opt_out_status != "success":
        return "leave"
    if flagged_sender(email):
        return "review"
    folder_l = (folder or "").lower()
    subject_l = (subject or "").lower()
    if any(phrase in subject_l for phrase in HOLD_SUBJECT):
        return "review"
    if folder_l in HOLD_FOLDERS or folder_l.startswith("category_updates"):
        return "review"
    if folder_l in MARKETING_FOLDERS:
        return "trash"
    return "review"
