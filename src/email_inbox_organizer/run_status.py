"""Run status from account results and database write outcomes. No mailbox contents."""


def finalize_run(account_results, writes=None):
    writes = writes or []
    if any(not write.get("ok") for write in writes):
        return "failed"
    if len(account_results) != 3:
        return "failed"
    if any(result.get("stored") is not True for result in account_results):
        return "failed"
    if any(result.get("error") and result.get("complete") is not False for result in account_results):
        return "failed"
    if any(result.get("complete") is not True for result in account_results):
        return "incomplete"
    if any(result.get("error") for result in account_results):
        return "failed"
    return "dry_run_complete"
