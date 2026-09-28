"""Exchange an Outlook authorization code and store the refresh token."""

from email_inbox_organizer.graph_auth import exchange_code


def complete_handoff(label, callback_url, expected_state, client_id, client_secret, redirect_uri, post, store, parse_callback):
    code = parse_callback(callback_url, expected_state)
    tokens = exchange_code(client_id, client_secret, code, redirect_uri, post)
    store(label, tokens["refresh_token"])
    return {"label": label, "stored": True, "apply_enabled": False}
