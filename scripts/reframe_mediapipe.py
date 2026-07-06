#!/usr/bin/env python3
import json
import sys

try:
    import mediapipe as mp  # type: ignore  # noqa: F401
except Exception:
    print(json.dumps({"ok": False, "error": "mediapipe_unavailable"}))
    sys.exit(0)

print(json.dumps({"ok": False, "error": "mediapipe_not_implemented_yet"}))
