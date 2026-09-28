"""Decide whether a read message may be filed. Unread mail is never filed."""

import re


def sender_of(message):
    addr = ((message.get("from") or {}).get("emailAddress") or {})
    return (addr.get("address") or "").lower(), addr.get("name") or ""


def subject_of(message):
    return message.get("subject") or ""


def is_flagged(message):
    return (message.get("flag") or {}).get("flagStatus") == "flagged"


def compile_rule(pattern):
    return re.compile(pattern) if pattern else None


def blocked(subject, rules):
    pattern = compile_rule(rules.get("global_exclude_subject"))
    return bool(pattern and pattern.search(subject or ""))


def match_spec(spec, email, domain, subject=""):
    kind = spec["match"]
    value = spec["value"].lower()
    if kind == "sender":
        return email == value
    if kind == "domain":
        return domain == value
    if kind == "domain_suffix":
        return domain == value or domain.endswith("." + value)
    if kind == "subject":
        return bool(re.search(spec["value"], subject or "", re.I))
    return False


def classify(message, rules):
    email, name = sender_of(message)
    domain = email.split("@")[-1] if "@" in email else email
    subject = subject_of(message)
    if message.get("isRead") is False:
        return {"action": "skip", "reason": "unread", "email": email, "folder": None}
    if message.get("isRead") is not True:
        return {"action": "leave", "reason": "unknown read state", "email": email, "folder": None}
    if is_flagged(message):
        return {"action": "skip", "reason": "flagged", "email": email, "folder": None}
    if subject.lower().startswith("inbox digest"):
        return {"action": "skip", "reason": "digest", "email": email, "folder": None}

    safety_hold = blocked(subject, rules)
    for spec in rules.get("auto_file", []):
        if not match_spec(spec, email, domain, subject):
            continue
        include = compile_rule(spec.get("include_subject"))
        if include and not include.search(subject or ""):
            continue
        if safety_hold and not spec.get("bypass_safety"):
            continue
        return {"action": "move", "reason": spec.get("reason") or "rule", "email": email, "folder": spec["folder"]}

    if not safety_hold:
        for spec in rules.get("receipts", []):
            if not match_spec(spec, email, domain, subject):
                continue
            include = compile_rule(spec.get("include_subject"))
            exclude = compile_rule(spec.get("exclude_subject"))
            if include and not include.search(subject or ""):
                continue
            if exclude and exclude.search(subject or ""):
                continue
            return {"action": "move", "reason": spec.get("reason") or "receipt", "email": email, "folder": spec["folder"]}

    for spec in rules.get("suggest", []):
        if match_spec(spec, email, domain, subject):
            return {"action": "suggest", "reason": "left in inbox", "email": email, "folder": spec["folder"]}
    return {"action": "leave", "reason": "left in inbox", "email": email, "folder": None}


def gmail_fallback(labels, email):
    """Used only after rules leave a read Gmail message unmatched."""
    if "CATEGORY_PROMOTIONS" in labels:
        return "Newsletters"
    if "CATEGORY_SOCIAL" in labels:
        return "Entertainment"
    automated = any(part in email for part in ("no-reply", "noreply", "donotreply", "do-not-reply", "notification"))
    if "CATEGORY_PERSONAL" in labels and not automated:
        return "Personal"
    if "CATEGORY_UPDATES" in labels or "CATEGORY_PERSONAL" in labels:
        return "Updates"
    return None


GMAIL_LABEL_NAMES = {"Important": "Priority"}


def gmail_label_name(folder):
    return GMAIL_LABEL_NAMES.get(folder, folder)
