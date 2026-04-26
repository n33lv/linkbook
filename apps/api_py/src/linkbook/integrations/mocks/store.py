"""Mock store — singleton dict-of-dicts shared across mock handlers.

Mirrors apps/api/src/integrations/_mocks/store.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MockInvoice:
    id: str
    customer_id: str
    customer_name: str
    doc_number: str
    amount_cents: int
    issued_at: str
    due_at: str
    paid_at: str | None
    status: str  # draft|sent|paid|voided
    source: str  # qbo|harvest


@dataclass
class MockPayment:
    id: str
    customer_name_raw: str
    amount_cents: int
    received_at: str
    applied_to_invoice_id: str | None


@dataclass
class MockContract:
    id: str
    title: str
    recipient: str
    status: str  # sent|viewed|signed|declined|expired
    sent_at: str
    signed_at: str | None


@dataclass
class MockTimeEntry:
    id: str
    user_id: str
    project_id: str
    date: str
    hours: float
    notes: str | None


@dataclass
class MockGmailMessage:
    id: str
    thread_id: str
    from_: str
    to: list[str]
    cc: list[str]
    subject: str
    body: str
    sent_at: str
    label_ids: list[str]


@dataclass
class FailureSpec:
    status: int
    body: Any | None = None


class FailureRegistry:
    def __init__(self) -> None:
        self._q: dict[str, list[FailureSpec]] = {}

    def queue_next(self, key: str, spec: FailureSpec) -> None:
        self._q.setdefault(key, []).append(spec)

    def consume(self, key: str) -> FailureSpec | None:
        lst = self._q.get(key)
        if not lst:
            return None
        spec = lst.pop(0)
        if not lst:
            self._q.pop(key, None)
        return spec

    def reset(self) -> None:
        self._q.clear()


@dataclass
class MockStore:
    invoices: dict[str, MockInvoice] = field(default_factory=dict)
    payments: dict[str, MockPayment] = field(default_factory=dict)
    contracts: dict[str, MockContract] = field(default_factory=dict)
    time_entries: dict[str, MockTimeEntry] = field(default_factory=dict)
    gmail_messages: dict[str, MockGmailMessage] = field(default_factory=dict)
    sent_emails: list[dict[str, Any]] = field(default_factory=list)
    contract_reminders: list[dict[str, Any]] = field(default_factory=list)
    airtable_records: dict[str, dict[str, Any]] = field(default_factory=dict)
    harvest_projects: dict[str, dict[str, Any]] = field(default_factory=dict)
    harvest_clients: dict[str, dict[str, Any]] = field(default_factory=dict)
    drive_folders: list[dict[str, Any]] = field(default_factory=list)
    failures: FailureRegistry = field(default_factory=FailureRegistry)


_STORE = MockStore()


def get_mock_store() -> MockStore:
    return _STORE


def reset_mock_store() -> None:
    s = _STORE
    s.invoices.clear()
    s.payments.clear()
    s.contracts.clear()
    s.time_entries.clear()
    s.gmail_messages.clear()
    s.sent_emails.clear()
    s.contract_reminders.clear()
    s.airtable_records.clear()
    s.harvest_projects.clear()
    s.harvest_clients.clear()
    s.drive_folders.clear()
    s.failures.reset()
