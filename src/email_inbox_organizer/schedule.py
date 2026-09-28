"""Monday and Thursday 8:00 a.m. America/Chicago slot, including daylight time."""

from datetime import datetime
from zoneinfo import ZoneInfo

CHICAGO = ZoneInfo("America/Chicago")
RUN_WEEKDAYS = {0, 3}  # Monday, Thursday
RUN_HOUR = 8


def chicago_slot(now_utc):
    if now_utc.tzinfo is None:
        raise ValueError("now_utc must be timezone-aware")
    local = now_utc.astimezone(CHICAGO)
    if local.weekday() not in RUN_WEEKDAYS or local.hour != RUN_HOUR:
        return None
    return local.strftime("%Y-%m-%dT08")


class SlotStore:
    def __init__(self):
        self.rows = {}

    def claim(self, slot_key):
        if slot_key in self.rows:
            return None
        self.rows[slot_key] = "running"
        return slot_key


def begin_scheduled_run(now_utc, store):
    slot = chicago_slot(now_utc)
    if slot is None:
        return {"action": "skip", "reason": "outside schedule"}
    claimed = store.claim(slot)
    if claimed is None:
        return {"action": "skip", "reason": "duplicate", "slot": slot}
    return {"action": "run", "slot": slot, "apply": False}
