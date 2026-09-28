import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from email_inbox_organizer.handoff import complete_handoff
from outlook_authorize import parse_callback

NODE_TEST = r"""
import { invocationAllowed, resolveSlot } from "./supabase/functions/outlook-sort/auth.ts";

const secret = "invoke-secret-value";
const denied = [
  [null, secret],
  ["", secret],
  ["Bearer wrong-secret-value", secret],
  ["Basic " + secret, secret],
  ["Bearer " + secret, ""],
];
for (const [header, expected] of denied) {
  if (invocationAllowed(header, expected)) {
    throw new Error("unauthorized request was accepted");
  }
}
if (!invocationAllowed("Bearer " + secret, secret)) {
  throw new Error("scheduled caller was rejected");
}
let filing;
try {
  filing = resolveSlot({ manual: true, run_key: "review001", apply: true }, new Date());
} catch (error) {
  filing = { status: 500 };
}
if (filing.status !== 200 || filing.apply !== true || filing.slot !== "manual:review001") {
  throw new Error("explicit manual apply was not isolated");
}
if (resolveSlot({ apply: true }, new Date("2026-09-28T12:00:00Z")).status !== 403) {
  throw new Error("scheduled apply was not rejected");
}
const manual = resolveSlot({ manual: true, run_key: "review001", apply: false }, new Date("2026-09-28T12:00:00Z"));
if (manual.slot !== "manual:review001" || manual.apply !== false) {
  throw new Error("manual dry run was not isolated");
}
const scheduled = resolveSlot({ apply: false }, new Date("2026-09-28T12:00:00Z"));
if (scheduled.body?.reason !== "outside schedule") {
  throw new Error("off-window schedule was not skipped");
}
const { runStatus } = await import("./supabase/functions/outlook-sort/auth.ts");
const { classifyInbox, previewMoves } = await import("./supabase/functions/outlook-sort/policy.ts");
const rules = { auto_file: [{ match: "domain", value: "offers.example", folder: "Promotions" }] };
const messages = [
  { id: "sale-1", subject: "Sale", from: { emailAddress: { address: "news@offers.example" } }, isRead: true, body: { secret: "do not return" } },
  { subject: "Unread sale", from: { emailAddress: { address: "news@offers.example" } }, isRead: false },
  { subject: "Flagged sale", from: { emailAddress: { address: "news@offers.example" } }, isRead: true, flag: { flagStatus: "flagged" } },
  { subject: "Personal", from: { emailAddress: { address: "friend@example.org" } }, isRead: true },
];
for (const m of messages) if (!m.flag) m.flag = { flagStatus: "notFlagged" };
const summary = classifyInbox(messages, rules);
const preview = previewMoves(messages, rules);
if (summary.would_file !== 1 || preview.length !== summary.would_file || preview[0].folder !== "Promotions" || JSON.stringify(preview).includes("do not return")) {
  throw new Error("preview differed from the dry-run decision or leaked message body");
}
const sensitiveRules = { auto_file: [
  { match: "domain_suffix", value: "microsoft.com", folder: "Tech", bypass_safety: true },
  { match: "domain_suffix", value: "whoop.com", folder: "Security", bypass_safety: true },
  { match: "domain_suffix", value: "att-mail.com", folder: "Finance", bypass_safety: true },
] };
const sensitive = [
  { subject: "New app(s) connected to your Microsoft account", from: { emailAddress: { address: "account-security-noreply@accountprotection.microsoft.com" } }, isRead: true },
  { subject: "New Sign-In Alert & Was This You?", from: { emailAddress: { address: "support@whoop.com" } }, isRead: true },
  { subject: "Here's your payment update", from: { emailAddress: { address: "update@account.att-mail.com" } }, isRead: true },
  { subject: "OAuth Application Approval", from: { emailAddress: { address: "noreply@microsoft.com" } }, isRead: true },
  { id: "weekly-news", subject: "Weekly product news", from: { emailAddress: { address: "news@microsoft.com" } }, isRead: true },
];
for (const m of sensitive) m.flag = { flagStatus: "notFlagged" };
if (classifyInbox(sensitive, sensitiveRules).would_file !== 1 || previewMoves(sensitive, sensitiveRules).length !== 1) {
  throw new Error("account and billing notices were filed by broad domain rules");
}
const stored = { complete: true, stored: true, error: null };
if (runStatus([stored, stored, { complete: true, stored: false, error: "result write failed" }]) === "dry_run_complete") {
  throw new Error("unstored result was treated as complete");
}
if (runStatus([stored, stored, stored]) !== "dry_run_complete") {
  throw new Error("three stored results were not complete");
}
console.log("ok invocation");
"""


def test_unauthorized_requests_and_manual_dry_run():
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", NODE_TEST],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    assert "ok invocation" in result.stdout


def test_handoff_exchanges_and_stores_without_returning_the_token():
    stored = {}

    def post(_url, form):
        assert form["grant_type"] == "authorization_code"
        assert form["code"] == "auth-code"
        return {"access_token": "access-token", "refresh_token": "refresh-token", "expires_in": 3600}

    def store(label, token, key=None):
        stored[label] = token

    result = complete_handoff(
        "personal-outlook-1",
        "http://127.0.0.1:8787/callback?code=auth-code&state=expected",
        "expected",
        "client-id",
        "client-secret",
        "http://127.0.0.1:8787/callback",
        post,
        store,
        parse_callback,
        lambda _access: "00000000-0000-0000-0000-000000000001",
        __import__("email_inbox_organizer.handoff", fromlist=["account_key"]).account_key(
            "00000000-0000-0000-0000-000000000001"
        ),
    )
    assert stored["personal-outlook-1"] == "refresh-token"
    assert result["stored"] is True
    assert result["account_key"]
    assert "refresh-token" not in json.dumps(result)
    assert "access-token" not in json.dumps(result)
    assert "@" not in json.dumps(result)


def test_handoff_refuses_a_different_signed_in_account():
    def post(_url, _form):
        return {"access_token": "access-token", "refresh_token": "refresh-token", "expires_in": 3600}

    def identify(_access):
        return "11111111-1111-1111-1111-111111111111"

    stored = {}

    def store(label, token, key=None):
        stored[label] = token

    from email_inbox_organizer.handoff import account_key

    result = complete_handoff(
        "personal-outlook-1",
        "http://127.0.0.1:8787/callback?code=auth-code&state=expected",
        "expected",
        "client-id",
        "client-secret",
        "http://127.0.0.1:8787/callback",
        post,
        store,
        parse_callback,
        identify,
        "ffffffffffffffff",
    )
    assert stored == {}
    assert result["stored"] is False
    assert result["account_key"] == account_key("11111111-1111-1111-1111-111111111111")
    assert "@" not in json.dumps(result)
    assert "refresh-token" not in json.dumps(result)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
    print("all passed")
