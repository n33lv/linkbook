"""§2.4 — deterministic idempotency key + 24h dedupe lookup."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from .db.models import Action
from .types import ACTION_CATALOG, ActionType


def _stable(value: Any) -> str:
    """JSON.stringify with sorted keys at every level. Stable hash input."""
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(k)}:{_stable(v)}" for k, v in sorted(value.items())) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_stable(x) for x in value) + "]"
    return json.dumps(value, default=str)


def compute_idempotency_key(
    type_: ActionType, subject_ref: str, params: dict[str, Any]
) -> str:
    """Hash (type, subject_ref, semantic_payload). Cosmetic params ignored."""
    entry = ACTION_CATALOG[type_]
    semantic = {f: params.get(f) for f in entry.semantic_fields}
    canonical = _stable({"type": type_, "subject_ref": subject_ref, "semantic": semantic})
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def find_duplicate_in_window(
    db: Session, idempotency_key: str, window_ms: int = 24 * 60 * 60 * 1000
) -> Action | None:
    """§2.4 — server rejects duplicate keys within 24h. Cancelled/failed/undone
    don't block fresh proposals.
    """
    since = datetime.utcnow() - timedelta(milliseconds=window_ms)
    rows = db.execute(
        select(Action).where(
            and_(
                Action.idempotency_key == idempotency_key,
                Action.created_at >= since,
                ~Action.status.in_(["cancelled", "failed", "undone"]),
            )
        )
    ).all()
    return rows[0][0] if rows else None
