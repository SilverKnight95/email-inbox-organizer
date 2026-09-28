import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from email_inbox_organizer.classify import classify, gmail_fallback, gmail_label_name
from email_inbox_organizer.review_policy import review
from email_inbox_organizer.unsubscribe_policy import may_unsubscribe

RULES = json.loads((ROOT / "config" / "rules.example.json").read_text())
FIXTURES = json.loads((ROOT / "tests" / "fixtures" / "messages.json").read_text())
BY_ID = {item["id"]: item for item in FIXTURES}


def test_unread_stays_in_inbox():
    decision = classify(BY_ID["fixture-unread-newsletter"], RULES)
    assert decision["action"] == "skip"
    assert decision["reason"] == "unread"


def test_read_newsletter_is_filed():
    decision = classify(BY_ID["fixture-read-newsletter"], RULES)
    assert decision["action"] == "move"
    assert decision["folder"] == "Newsletters"


def test_security_subject_is_not_filed_as_newsletter():
    decision = classify(BY_ID["fixture-security"], RULES)
    assert decision["action"] != "move" or decision["folder"] == "Security"


def test_receipt_files_and_declined_payment_does_not():
    assert classify(BY_ID["fixture-receipt"], RULES)["folder"] == "Finance"
    assert classify(BY_ID["fixture-declined"], RULES)["action"] != "move"


def test_gmail_label_and_fallback():
    assert gmail_label_name("Important") == "Priority"
    assert gmail_fallback(["CATEGORY_PROMOTIONS"], "deals@news.example") == "Newsletters"
    assert gmail_fallback(["CATEGORY_UPDATES"], "person@example.com") == "Updates"


def test_unsubscribe_skips_school_security_and_spam():
    assert may_unsubscribe("deals@news.example", "50% off", in_spam=False)
    assert not may_unsubscribe("office@school.example.edu", "Campus note", in_spam=False)
    assert not may_unsubscribe("deals@news.example", "Your verification code", in_spam=False)
    assert not may_unsubscribe("deals@news.example", "50% off", in_spam=True)


def test_trash_only_successful_marketing():
    assert review("Newsletters", "50% off this week", "success", "deals@news.example") == "trash"
    assert review("Newsletters", "50% off this week", "failed", "deals@news.example") == "leave"
    assert review("Orders", "50% off this week", "success", "deals@news.example") == "review"
    assert review("Newsletters", "Your receipt", "success", "deals@news.example") == "review"
    assert review("Newsletters", "Summer sale", "success", "shipment-notice@carrier.example") == "review"
    assert review("Health", "Tips for you", "success", "deals@news.example") == "review"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
    print("all passed")
