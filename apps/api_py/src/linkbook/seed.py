"""Idempotent seed mirroring apps/api/src/seed.ts.

14 clients, 9 projects, 22 invoices, 14d time entries, 7 inbox events.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta

from sqlalchemy import select

from .config import load_config
from .db import open_session, get_engine
from .db.models import (
    Base,
    Client,
    IntegrationConnection,
    Invoice,
    Project,
)
from .ingestion import IngestInput, ingest_event
from .integrations.mocks import get_mock_store, install_mock_transport, reset_mock_store
from .integrations.mocks.store import MockInvoice, MockPayment, MockTimeEntry
from .lib.log import app_logger, configure


CLIENTS = [
    ("Stellate Studios", 1),
    ("Halford & Co.", 1),
    ("Petal & Vine", 1),
    ("Ridgemoor Group", 1),
    ("Cypress Labs", 2),
    ("Brightside Goods", 2),
    ("Northbeam Inc.", 2),
    ("Meadowlark Co.", 2),
    ("Linkwell", 2),
    ("Cypress Bay", 2),
    ("Hill & Houseman", 3),
    ("Foxglove Press", 3),
    ("Marlowe Editorial", 3),
    ("Kestrel & Co.", 3),
]

PROJECTS = [
    ("Petal & Vine", "Spring Campaign", 132, 132, 9),
    ("Halford & Co.", "Annual Report 2026", 120, 98, 17),
    ("Ridgemoor Group", "Site Redesign", 240, 186, 3),
    ("Cypress Labs", "Brand Refresh", 120, 62, 5),
    ("Brightside Goods", "Packaging", 60, 44, 0),
    ("Northbeam Inc.", "Brand System", 240, 0, 0),
    ("Stellate Studios", "Q2 Editorial", 200, 88, 2),
    ("Meadowlark Co.", "Wayfinding", 80, 12, 0),
    ("Linkwell", "Web Type System", 200, 156, 4),
]

# (client, number, amount_dollars, days_overdue, paid)
INVOICES = [
    ("Stellate Studios", "INV-1041", 18_400, 62, False),
    ("Halford & Co.", "INV-1029", 14_800, 41, False),
    ("Petal & Vine", "INV-1044", 11_250, 22, False),
    ("Ridgemoor Group", "INV-1048", 9_800, 15, False),
    ("Brightside Goods", "INV-1050", 8_250, 12, False),
    ("Cypress Labs", "INV-1052", 6_400, 4, False),
    ("Stellate Studios", "INV-1015", 14_400, 105, False),
    ("Halford & Co.", "INV-1018", 8_200, 95, False),
    ("Stellate Studios", "INV-1051", 12_000, -10, True),
    ("Petal & Vine", "INV-1049", 9_400, -20, True),
    ("Linkwell", "INV-1042", 8_600, -45, True),
    ("Cypress Labs", "INV-1043", 12_300, -38, True),
]

PEOPLE = ["Neel B.", "Asha P.", "Marcus L.", "Rohan T.", "Wren H."]
HARVEST_USER_BY = {p: p.replace(" ", "_").replace(".", "").lower() for p in PEOPLE}


async def main() -> int:
    cfg = load_config()
    configure(cfg.LOG_LEVEL)
    log = app_logger()

    eng = get_engine(cfg.DATABASE_URL)
    Base.metadata.create_all(eng)
    install_mock_transport()
    reset_mock_store()

    db = open_session()
    try:
        # 1. Integration connections
        for src in ("qbo", "harvest", "dropboxsign", "airtable", "gmail"):
            existing = db.execute(
                select(IntegrationConnection).where(IntegrationConnection.source == src)
            ).scalar_one_or_none()
            if existing is not None:
                continue
            meta = (
                {"base_id": "app_demo", "projects_table_id": "tbl_projects"}
                if src == "airtable"
                else {}
            )
            db.add(
                IntegrationConnection(
                    source=src,
                    external_account_id="realm_dev" if src == "qbo" else f"{src}_acct",
                    display_name=src.upper(),
                    status="connected",
                    access_token="dev_token",
                    metadata_=meta,
                )
            )
        db.commit()

        # 2. Clients
        client_by_name: dict[str, str] = {}
        for name, tier in CLIENTS:
            existing = db.execute(select(Client).where(Client.name == name)).scalar_one_or_none()
            if existing is not None:
                client_by_name[name] = existing.id
                continue
            slug = name.replace(" ", "_").replace("&", "_").replace(".", "").replace(",", "").lower()
            c = Client(
                name=name,
                tier=tier,
                source_ids={"qbo": f"qbo_{slug}", "harvest": f"h_{slug}"},
                email_domains=[f"{name.split()[0].lower()}.com"],
            )
            db.add(c)
            db.commit()
            db.refresh(c)
            client_by_name[name] = c.id

        # 3. Projects
        project_by_name: dict[str, str] = {}
        for client, name, budget, used, days_silent in PROJECTS:
            existing = db.execute(select(Project).where(Project.name == name)).scalar_one_or_none()
            if existing is not None:
                project_by_name[name] = existing.id
                continue
            slug = name.replace(" ", "_").lower()
            p = Project(
                client_id=client_by_name[client],
                name=name,
                harvest_project_id=f"harvest_{slug}",
                airtable_record_id=f"rec_{slug}",
                status="over" if used / max(budget, 1) >= 1 else "active",
                owner="Asha",
                budget_hours=budget,
                hours_used=used,
                last_status_update_at=datetime.utcnow() - timedelta(days=days_silent),
            )
            db.add(p)
            db.commit()
            db.refresh(p)
            project_by_name[name] = p.id

        # 4. Invoices
        store = get_mock_store()
        today = datetime.utcnow()
        for client, number, dollars, days_overdue, paid in INVOICES:
            existing = db.execute(select(Invoice).where(Invoice.number == number)).scalar_one_or_none()
            if existing is not None:
                continue
            due_at = today - timedelta(days=days_overdue)
            issued_at = due_at - timedelta(days=30)
            days_to_close = (10 + abs(days_overdue) % 25) if paid else 0
            paid_at = (issued_at + timedelta(days=days_to_close)) if paid else None
            db.add(
                Invoice(
                    client_id=client_by_name[client],
                    number=number,
                    amount_cents=dollars * 100,
                    qbo_invoice_id=f"qbo_{number}",
                    harvest_invoice_id=f"h_{number}",
                    status="paid" if paid else "sent",
                    issued_at=issued_at,
                    due_at=due_at,
                    paid_at=paid_at,
                )
            )
            store.invoices[f"qbo_{number}"] = MockInvoice(
                id=f"qbo_{number}",
                customer_id=f"qbo_{client.replace(' ', '_').lower()}",
                customer_name=client,
                doc_number=number,
                amount_cents=dollars * 100,
                issued_at=issued_at.isoformat(),
                due_at=due_at.isoformat(),
                paid_at=paid_at.isoformat() if paid_at else None,
                status="paid" if paid else "sent",
                source="qbo",
            )
        db.commit()

        # 5. Time entries (drive Utilization)
        from random import randint

        for i in range(13, -1, -1):
            d = today - timedelta(days=i)
            wd = d.weekday()
            if wd >= 5:  # Sat/Sun
                continue
            for p in PEOPLE:
                user = HARVEST_USER_BY[p]
                date_key = d.date().isoformat()
                key = f"te_{user}_{date_key}"
                if key in store.time_entries:
                    continue
                store.time_entries[key] = MockTimeEntry(
                    id=key,
                    user_id=user,
                    project_id="harvest_spring_campaign",
                    date=date_key,
                    hours=3 + randint(0, 3),
                    notes=None,
                )

        # 6. The 7 inbox events
        # 1. Stellate aging_60 — Cash Chaser
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="qbo",
                type="invoice.aging_60",
                subject_ref="invoice:qbo_INV-1041",
                occurred_at=datetime.utcnow(),
                payload={
                    "invoice_id": "qbo_INV-1041",
                    "client_id": client_by_name["Stellate Studios"],
                    "amount_cents": 1_840_000,
                    "currency": "USD",
                    "issued_at": (today - timedelta(days=62)).isoformat(),
                    "due_at": (today - timedelta(days=62)).isoformat(),
                    "days_overdue": 62,
                },
                dedupe_key="aging_60",
            ),
        )

        # 2. Northbeam contract.signed — Project Concierge
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="dropboxsign",
                type="contract.signed",
                subject_ref="contract:sig_northbeam_msa",
                occurred_at=datetime.utcnow() - timedelta(minutes=14),
                payload={
                    "signature_request_id": "sig_northbeam_msa",
                    "title": "Northbeam — MSA",
                    "client_id": client_by_name["Northbeam Inc."],
                    "sent_at": (datetime.utcnow() - timedelta(days=5)).isoformat(),
                    "signed_at": (datetime.utcnow() - timedelta(minutes=14)).isoformat(),
                },
                dedupe_key="signed",
            ),
        )

        # 3. Brightside invoice.draft_ready_to_send
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="harvest",
                type="invoice.draft_ready_to_send",
                subject_ref="invoice:h_H-0427",
                occurred_at=datetime.utcnow() - timedelta(hours=26),
                payload={
                    "harvest_invoice_id": "H-0427",
                    "client_id": client_by_name["Brightside Goods"],
                    "amount_cents": 825_000,
                    "drafted_at": (datetime.utcnow() - timedelta(hours=26)).isoformat(),
                },
                dedupe_key="ready",
            ),
        )

        # 4. Petal & Vine budget threshold 100
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="harvest",
                type="time.budget_threshold_100",
                subject_ref=f"project:{project_by_name['Spring Campaign']}",
                occurred_at=datetime.utcnow(),
                payload={
                    "project_id": project_by_name["Spring Campaign"],
                    "harvest_project_id": "harvest_spring_campaign",
                    "hours_used": 132,
                    "hours_budgeted": 132,
                    "pct": 1.0,
                },
                dedupe_key="t100",
            ),
        )

        # 5. Halford status_stale
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="airtable",
                type="project.status_stale",
                subject_ref=f"project:{project_by_name['Annual Report 2026']}",
                occurred_at=datetime.utcnow(),
                payload={
                    "project_id": project_by_name["Annual Report 2026"],
                    "airtable_record_id": "rec_annual_report_2026",
                    "days_silent": 17,
                },
                dedupe_key="stale_17",
            ),
        )

        # 6. payment.received_unapplied — multi-candidate, Reconciler stays manual
        store.payments["qbo_pay_1"] = MockPayment(
            id="qbo_pay_1",
            customer_name_raw="STELLATE STUDIOS LLC",
            amount_cents=640_000,
            received_at=datetime.utcnow().isoformat(),
            applied_to_invoice_id=None,
        )
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="qbo",
                type="payment.received_unapplied",
                subject_ref="payment:qbo_pay_1",
                occurred_at=datetime.utcnow(),
                payload={
                    "qbo_payment_id": "qbo_pay_1",
                    "customer_name_raw": "STELLATE STUDIOS LLC",
                    "amount_cents": 640_000,
                    "received_at": datetime.utcnow().isoformat(),
                    "candidate_invoice_ids": ["qbo_INV-1041", "qbo_INV-1015"],
                },
                dedupe_key="unapplied",
            ),
        )

        # 7. time.missing_yesterday
        y = datetime.utcnow() - timedelta(days=1)
        await ingest_event(
            cfg,
            db,
            log,
            IngestInput(
                source="harvest",
                type="time.missing_yesterday",
                subject_ref=f"time_entry:neel-{y.date().isoformat()}",
                occurred_at=datetime.utcnow(),
                payload={
                    "harvest_user_id": "neel_b",
                    "date": y.date().isoformat(),
                    "hours_logged": 2.5,
                },
                dedupe_key="missing",
            ),
        )

        print("seed complete")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
