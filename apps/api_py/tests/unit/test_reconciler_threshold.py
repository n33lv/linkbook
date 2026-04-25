"""Unit — §5.3 reconciler threshold."""

from linkbook.types import RECONCILER_CONFIDENCE_THRESHOLD


def test_threshold_is_85():
    assert RECONCILER_CONFIDENCE_THRESHOLD == 0.85
