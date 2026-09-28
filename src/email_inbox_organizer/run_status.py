"""Run status from account results and database write outcomes. No mailbox contents."""


def finalize_run(account_results, writes):
    if any(not write.get("ok") for write in writes):
        return "failed"
    if any(result.get("error") and result.get("complete") is not False for result in account_results):
        return "failed"
    if any(result.get("complete") is False for result in account_results):
        return "incomplete"
    if any(result.get("error") for result in account_results):
        return "failed"
    if not account_results:
        return "failed"
    return "dry_run_complete"
