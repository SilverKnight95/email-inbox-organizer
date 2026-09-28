"""Exchange an Outlook authorization code and store the refresh token."""

import hashlib

from email_inbox_organizer.graph_auth import exchange_code


def account_key(graph_user_id):
    return hashlib.sha256(graph_user_id.strip().lower().encode()).hexdigest()[:16]


def complete_handoff(
    label,
    callback_url,
    expected_state,
    client_id,
    client_secret,
    redirect_uri,
    post,
    store,
    parse_callback,
    identify,
    expected_key,
):
    code = parse_callback(callback_url, expected_state)
    tokens = exchange_code(client_id, client_secret, code, redirect_uri, post)
    key = account_key(identify(tokens["access_token"]))
    if not expected_key or key != expected_key:
        return {
            "label": label,
            "stored": False,
            "apply_enabled": False,
            "account_key": key,
            "reason": "signed-in account does not match this slot",
        }
    store(label, tokens["refresh_token"], key)
    return {"label": label, "stored": True, "apply_enabled": False, "account_key": key}
