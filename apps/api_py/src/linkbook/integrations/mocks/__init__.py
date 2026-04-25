"""Integration mock layer.

Singleton `mock_store` holds in-memory state; per-source handlers route
HTTP requests against it. install_mock_transport() swaps the global HTTP
transport for one that dispatches by hostname.
"""

from .store import MockInvoice, MockPayment, get_mock_store, reset_mock_store
from .transport import MockTransport, install_mock_transport

__all__ = [
    "MockInvoice",
    "MockPayment",
    "MockTransport",
    "get_mock_store",
    "install_mock_transport",
    "reset_mock_store",
]
