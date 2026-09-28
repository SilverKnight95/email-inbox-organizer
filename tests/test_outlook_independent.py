import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from email_inbox_organizer.graph_auth import authorize_url, exchange_code, refresh_access_token
from email_inbox_organizer.outlook_adapter import ReadOnlyGraph, apply_filing, dry_run_account
from email_inbox_organizer.schedule import SlotStore, begin_scheduled_run, chicago_slot

RULES = json.loads((ROOT / "config" / "rules.example.json").read_text())
MESSAGES = json.loads((ROOT / "tests" / "fixtures" / "outlook_inbox.json").read_text())


def test_authorize_url_has_no_secret():
    url = authorize_url("client-id", "https://example.com/callback", "state-1")
    assert "client_secret" not in url
    assert "client-id" in url
    assert "consumers" in url
    assert "offline_access" in url


def test_token_exchange_and_refresh_keep_refresh_token():
    seen = {}

    def post(url, form):
        seen["url"] = url
        seen["form"] = form
        return {"access_token": "access-1", "refresh_token": "refresh-2", "expires_in": "120"}

    exchanged = exchange_code("client", "secret", "code-1", "https://example.com/callback", post)
    assert exchanged["refresh_token"] == "refresh-2"
    assert seen["form"]["grant_type"] == "authorization_code"
    refreshed = refresh_access_token("client", "secret", "refresh-2", post)
    assert refreshed["access_token"] == "access-1"
    assert seen["form"]["grant_type"] == "refresh_token"
    assert "secret" not in json.dumps(refreshed)


def test_dry_run_is_read_only_and_counts_review_mail():
    calls = []

    def transport(method, path, query, body):
        calls.append(method)
        if path.endswith("/messages") and query.get("$skip") == "0":
            return {"value": MESSAGES}
        return {"value": []}

    summary = dry_run_account(ReadOnlyGraph(transport), RULES)
    assert calls and set(calls) == {"GET"}
    assert summary["inbox_scanned"] == 5
    assert summary["would_file"] == 2
    assert summary["left_unread"] == 1
    assert summary["left_flagged"] == 1
    assert summary["left_for_review"] == 1
    assert summary["filed"] == 0
    assert summary["by_folder"] == {"Newsletters": 1, "Security": 1}


def test_apply_stays_disabled():
    def transport(method, path, query, body):
        raise AssertionError("apply must not call Graph")

    try:
        apply_filing(ReadOnlyGraph(transport), RULES, allow_apply=False)
    except RuntimeError as exc:
        assert "disabled" in str(exc)
    else:
        raise AssertionError("expected live filing to stay disabled")


def test_monday_and_thursday_chicago_slot_and_duplicate_guard():
    monday = datetime(2026, 9, 28, 13, 5, tzinfo=timezone.utc)
    thursday = datetime(2026, 10, 1, 13, 0, tzinfo=timezone.utc)
    winter_monday = datetime(2026, 1, 5, 14, 30, tzinfo=timezone.utc)
    too_early = datetime(2026, 9, 28, 12, 30, tzinfo=timezone.utc)
    assert chicago_slot(monday) == "2026-09-28T08"
    assert chicago_slot(thursday) == "2026-10-01T08"
    assert chicago_slot(winter_monday) == "2026-01-05T08"
    assert chicago_slot(too_early) is None
    store = SlotStore()
    first = begin_scheduled_run(monday, store)
    second = begin_scheduled_run(monday, store)
    assert first == {"action": "run", "slot": "2026-09-28T08", "apply": False}
    assert second["reason"] == "duplicate"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
    print("all passed")
