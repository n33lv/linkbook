"""Unit — §2.4 idempotency hash."""

from linkbook.idempotency import compute_idempotency_key


def test_stable_across_key_ordering():
    a = compute_idempotency_key(
        "invoice.remind",
        "invoice:42",
        {"recipient": "a@x.com", "invoice_id": "INV-42", "tone": "firm", "body": "long body", "subject": "s"},
    )
    b = compute_idempotency_key(
        "invoice.remind",
        "invoice:42",
        {"tone": "firm", "body": "long body", "recipient": "a@x.com", "subject": "s", "invoice_id": "INV-42"},
    )
    assert a == b


def test_cosmetic_edits_dont_change_key():
    a = compute_idempotency_key(
        "invoice.remind",
        "invoice:42",
        {"recipient": "a@x.com", "invoice_id": "INV-42", "tone": "firm", "body": "V1", "subject": "X"},
    )
    b = compute_idempotency_key(
        "invoice.remind",
        "invoice:42",
        {"recipient": "a@x.com", "invoice_id": "INV-42", "tone": "firm", "body": "V2 — totally rewritten", "subject": "Y"},
    )
    assert a == b


def test_semantic_edits_change_key():
    polite = compute_idempotency_key(
        "invoice.remind", "invoice:42",
        {"recipient": "a@x.com", "invoice_id": "INV-42", "tone": "polite"},
    )
    firm = compute_idempotency_key(
        "invoice.remind", "invoice:42",
        {"recipient": "a@x.com", "invoice_id": "INV-42", "tone": "firm"},
    )
    assert polite != firm


def test_different_recipient_different_key():
    a = compute_idempotency_key(
        "invoice.remind", "invoice:42",
        {"recipient": "a@x.com", "invoice_id": "INV-42", "tone": "firm"},
    )
    b = compute_idempotency_key(
        "invoice.remind", "invoice:42",
        {"recipient": "b@x.com", "invoice_id": "INV-42", "tone": "firm"},
    )
    assert a != b
