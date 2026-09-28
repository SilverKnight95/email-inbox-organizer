#!/usr/bin/env python3
"""Print or complete personal Outlook authorization. Does not start unless asked.

Do not commit the refresh token this script can receive. Live filing stays off.
"""

import argparse
import json
import secrets
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from email_inbox_organizer.graph_auth import authorize_url
from email_inbox_organizer.handoff import complete_handoff

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
    parser.add_argument("--redirect-uri", default="http://localhost:8787/callback")
    parser.add_argument("--callback-url")
    parser.add_argument("--state-file", default="")
    parser.add_argument("--complete", action="store_true")
    args = parser.parse_args()
    state_path = Path(args.state_file) if args.state_file else Path(tempfile.gettempdir()) / f"outlook-auth-{args.label}.state"
    if args.complete:
        import os
        import urllib.parse
        import urllib.request

        secret = os.environ.get("AZURE_CLIENT_SECRET", "")
        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not args.callback_url:
            raise SystemExit("callback URL is required")
        if not secret or not supabase_url or not service_key:
            raise SystemExit("missing authorization configuration")
        state = state_path.read_text().strip()

        def post(url, form):
            data = urllib.parse.urlencode(form).encode()
            req = urllib.request.Request(url, data=data, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)

        def graph_id(access_token):
            req = urllib.request.Request(
                "https://graph.microsoft.com/v1.0/me?$select=id",
                headers={"authorization": f"Bearer {access_token}"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)["id"]

        def expected_key(label):
            body = json.dumps({"account_label": label}).encode()
            req = urllib.request.Request(
                f"{supabase_url}/rest/v1/rpc/organizer_expected_account_key",
                data=body,
                method="POST",
                headers={
                    "apikey": service_key,
                    "authorization": f"Bearer {service_key}",
                    "content-type": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                value = json.load(resp)
            return value or ""

        def store(label, token, key):
            body = json.dumps({"account_label": label, "token": token, "account_key": key}).encode()
            req = urllib.request.Request(
                f"{supabase_url}/rest/v1/rpc/organizer_store_refresh_token_by_label",
                data=body,
                method="POST",
                headers={
                    "apikey": service_key,
                    "authorization": f"Bearer {service_key}",
                    "content-type": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status >= 300:
                    raise SystemExit("refresh token was not stored")

        result = complete_handoff(
            args.label,
            args.callback_url,
            state,
            args.client_id,
            secret,
            args.redirect_uri,
            post,
            store,
            parse_callback,
            graph_id,
            expected_key(args.label),
        )
        state_path.unlink(missing_ok=True)
        print(json.dumps(result))
        return
    state = secrets.token_urlsafe(24)
    state_path.write_text(state)
    print(authorize_url(args.client_id, args.redirect_uri, state))
    print(f"state saved outside the repo at {state_path}")


if __name__ == "__main__":
    main()
