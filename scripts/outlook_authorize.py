#!/usr/bin/env python3
"""Print or complete personal Outlook authorization. Does not start unless asked.

Do not commit the refresh token this script can receive. Live filing stays off.
"""

import argparse
import json
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from email_inbox_organizer.graph_auth import authorize_url, exchange_code

LABELS = ("personal-outlook-1", "personal-outlook-2", "personal-outlook-3")


def parse_callback(url, expected_state):
    query = parse_qs(urlparse(url).query)
    state = (query.get("state") or [""])[0]
    if state != expected_state:
        raise SystemExit("state mismatch; refusing to exchange the code")
    if query.get("error"):
        raise SystemExit("authorization denied")
    code = (query.get("code") or [""])[0]
    if not code:
        raise SystemExit("callback is missing a code")
    return code


def main():
    parser = argparse.ArgumentParser(description="Authorize one personal Outlook account")
    parser.add_argument("--label", required=True, choices=LABELS)
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--redirect-uri", default="http://127.0.0.1:8787/callback")
    parser.add_argument("--callback-url")
    parser.add_argument("--state-file", default="")
    args = parser.parse_args()
    state_path = Path(args.state_file) if args.state_file else Path(f"/tmp/outlook-auth-{args.label}.state")
    if args.callback_url:
        state = state_path.read_text().strip()
        code = parse_callback(args.callback_url, state)
        print(json.dumps({"label": args.label, "code_received": True, "code_length": len(code)}))
        print("Exchange the code with exchange_code and store the refresh token in Vault.")
        print("Leave apply_enabled false. Do not print or commit the token.")
        return
    state = secrets.token_urlsafe(24)
    state_path.write_text(state)
    print(authorize_url(args.client_id, args.redirect_uri, state))
    print(f"state saved outside the repo at {state_path}")


if __name__ == "__main__":
    main()
