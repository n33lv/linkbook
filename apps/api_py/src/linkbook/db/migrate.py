"""Apply schema to the configured DATABASE_URL.

For v1 we use SQLAlchemy's create_all() — the schema is small and stable.
When we need real migrations (column add, type change), wire Alembic; the
env infrastructure is here.
"""

from __future__ import annotations

import os
import sys

from .engine import create_engine_from_url
from .models import Base


def main() -> int:
    url = os.environ.get("DATABASE_URL", "file:./linkbook.db")
    eng = create_engine_from_url(url)
    Base.metadata.create_all(eng)
    print(f"migrations applied → {url}")
    eng.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())
