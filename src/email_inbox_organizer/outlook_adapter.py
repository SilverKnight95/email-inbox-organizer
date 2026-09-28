"""Read-only dry run and gated filing for personal Outlook accounts.

Graph writes are refused unless apply is explicitly enabled. The scheduled job
never enables apply.
"""

from email_inbox_organizer.classify import classify

GRAPH = "https://graph.microsoft.com/v1.0"


class GraphError(RuntimeError):
    pass


class ReadOnlyGraph:
    def __init__(self, transport):
        self.transport = transport

    def request(self, method, path, query=None, body=None):
        if method.upper() != "GET":
            raise GraphError("dry run cannot write to the mailbox")
        return self.transport(method, path, query, body)


def list_inbox(graph):
    skip = 0
    while True:
        page = graph.request(
            "GET",
            "/me/mailFolders/inbox/messages",
            query={
                "$top": "50",
                "$skip": str(skip),
                "$select": "id,subject,from,isRead,flag,parentFolderId",
            },
        )
        values = page.get("value") or []
        if not values:
            break
        yield from values
        skip += len(values)
        if skip > 5000:
            break


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
    return summarize_account(list_inbox(graph), rules)


def apply_filing(graph, rules, allow_apply=False):
    if not allow_apply:
        raise GraphError("live filing is disabled until a dry run has been reviewed")
    raise GraphError("scheduled job must not file until apply is enabled on the account")
