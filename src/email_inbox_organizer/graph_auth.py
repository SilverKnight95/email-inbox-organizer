"""Microsoft identity authorization and refresh for personal Outlook accounts."""

from urllib.parse import urlencode

AUTHORIZE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"
TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
SCOPES = (
    "offline_access",
    "https://graph.microsoft.com/User.Read",
    "https://graph.microsoft.com/Mail.ReadWrite",
)


def authorize_url(client_id, redirect_uri, state):
    query = urlencode(
        {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "response_mode": "query",
            "scope": " ".join(SCOPES),
            "state": state,
            "prompt": "select_account",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def _token_request(form, post):
    payload = post(TOKEN_URL, form)
    if "access_token" not in payload or "refresh_token" not in payload:
        raise RuntimeError("token response missing access or refresh token")
    return {
        "access_token": payload["access_token"],
        "refresh_token": payload["refresh_token"],
        "expires_in": int(payload.get("expires_in") or 3600),
    }


def exchange_code(client_id, client_secret, code, redirect_uri, post):
    return _token_request(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "scope": " ".join(SCOPES),
        },
        post,
    )


def refresh_access_token(client_id, client_secret, refresh_token, post):
    return _token_request(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": " ".join(SCOPES),
        },
        post,
    )
