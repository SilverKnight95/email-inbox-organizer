"""Read-only dry run and gated filing for personal Outlook accounts.

Graph writes are refused unless apply is explicitly enabled. The scheduled job
never enables apply. Inbox reads follow @odata.nextLink. A scan that stops
early is incomplete and must not be reported as a full count.
"""

from urllib.parse import urlparse

from email_inbox_organizer.classify import classify

GRAPH_HOST = "graph.microsoft.com"
MAX_MESSAGES = 10000


class GraphError(RuntimeError):
    pass


class ReadOnlyGraph:
    def __init__(self, transport):
        self.transport = transport

    def request(self, method, path, query=None, body=None):
        if method.upper() != "GET":
            raise GraphError("dry run cannot write to the mailbox")
        return self.transport(method, path, query, body)


def graph_path(link):
    if not link:
        return None
    if link.startswith("/"):
        return link
    parsed = urlparse(link)
    if parsed.netloc != GRAPH_HOST:
        raise GraphError("unexpected Graph next link")
    path = parsed.path
    if path.startswith("/v1.0"):
        path = path[len("/v1.0"):]
    if parsed.query:
        path = f"{path}?{parsed.query}"
    return path


def list_inbox(graph):
    path = "/me/mailFolders/inbox/messages"
    query = {
        "$top": "50",
        "$select": "id,subject,from,isRead,flag,parentFolderId",
    }
    messages = []
    while path:
        page = graph.request("GET", path, query)
        query = None
        values = page.get("value") or []
        messages.extend(values)
        nxt = page.get("@odata.nextLink")
        if not nxt:
            return messages, True
        if len(messages) >= MAX_MESSAGES:
            return messages, False
        path = graph_path(nxt)
    return messages, True


def summarize_account(messages, rules):
    summary = {
        "inbox_scanned": 0,
        "would_file": 0,
        "left_unread": 0,
        "left_flagged": 0,
        "left_for_review": 0,
        "filed": 0,
        "by_folder": {},
    }
    for message in messages:
        summary["inbox_scanned"] += 1
        decision = classify(message, rules)
        if decision["reason"] == "unread":
            summary["left_unread"] += 1
        elif decision["reason"] == "flagged":
            summary["left_flagged"] += 1
        elif decision["action"] == "move":
            summary["would_file"] += 1
            folder = decision["folder"]
            summary["by_folder"][folder] = summary["by_folder"].get(folder, 0) + 1
        else:
            summary["left_for_review"] += 1
    return summary


def dry_run_account(graph, rules):
    messages, complete = list_inbox(graph)
    summary = summarize_account(messages, rules)
    summary["complete"] = complete
    if not complete:
        summary["error"] = "partial scan"
    return summary


def accept_refreshed_token(previous_refresh, payload, save_refresh):
    """Persist a replacement refresh token before the run may succeed."""
    access = payload.get("access_token")
    refreshed = payload.get("refresh_token")
    if not access or not refreshed:
        raise GraphError("token response incomplete")
    if refreshed != previous_refresh:
        save_refresh(refreshed)
    return access


def apply_filing(graph, rules, allow_apply=False):
    if not allow_apply:
        raise GraphError("live filing is disabled until a dry run has been reviewed")
    raise GraphError("scheduled job must not file until apply is enabled on the account")
