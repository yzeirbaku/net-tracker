"""Shared pytest config. Sets safe defaults for env vars so the suite runs hermetically.

The sub-conftest in tests/api/ owns the DB fixture.
"""

import os

os.environ.setdefault("MAGIC_LINK_DEV_PRINT", "1")
os.environ.setdefault("MAGIC_LINK_BASE_URL", "http://localhost:8080")
