#!/usr/bin/env python3
"""Classify the synthetic fixture. Does not connect to mail."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from email_inbox_organizer.classify import classify

rules = json.loads((ROOT / "config" / "rules.example.json").read_text())
messages = json.loads((ROOT / "tests" / "fixtures" / "messages.json").read_text())
for message in messages:
    decision = classify(message, rules)
    print(message["id"], decision["action"], decision.get("folder") or decision.get("reason"))
