"""§3 — five dashboard views."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from ..db import get_session
from ..db.models import Client, Event, Invoice, Project

router = APIRouter()


def _start_of_quarter() -> datetime:
    now = datetime.utcnow()
    qm = now.month - ((now.month - 1) % 3)
    return datetime(now.year, qm, 1)


@router.get("/dashboard/cash")
async def cash(db: Session = Depends(get_session)) -> dict[str, Any]:
    open_invoices = db.execute(select(Invoice).where(Invoice.status != "paid")).scalars().all()
    now = datetime.utcnow()
    buckets = {"0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0}
    total = 0
    for inv in open_invoices:
        due = inv.due_at if inv.due_at else now
        days = max(0, (now - due).days)
        total += inv.amount_cents
        if days <= 30:
            buckets["0_30"] += inv.amount_cents
        elif days <= 60:
            buckets["31_60"] += inv.amount_cents
        elif days <= 90:
            buckets["61_90"] += inv.amount_cents
        else:
            buckets["90_plus"] += inv.amount_cents

    qstart = _start_of_quarter()
    paid_this_q = (
        db.execute(
            select(Invoice).where(and_(Invoice.status == "paid", Invoice.paid_at >= qstart))
        )
        .scalars()
        .all()
    )
    qtd_cash = sum(i.amount_cents for i in paid_this_q)

    issued_this_q = (
        db.execute(select(Invoice).where(Invoice.issued_at >= qstart)).scalars().all()
    )
    qtd_accrual = sum(i.amount_cents for i in issued_this_q)

    top = sorted(open_invoices, key=lambda i: i.amount_cents, reverse=True)[:5]
    clients_by_id = {c.id: c for c in db.execute(select(Client)).scalars().all()}

    since = now - timedelta(days=90)
    recent_paid = (
        db.execute(
            select(Invoice).where(and_(Invoice.status == "paid", Invoice.paid_at >= since))
        )
        .scalars()
        .all()
    )
    days_list = [
        (i.paid_at - i.issued_at).total_seconds() / 86400
        for i in recent_paid
        if i.paid_at and i.issued_at
    ]
    avg_days = round(sum(days_list) / len(days_list)) if days_list else 0

    return {
        "ar_aging": buckets,
        "ar_total_cents": total,
        "qtd_revenue_cash_cents": qtd_cash,
        "qtd_revenue_accrual_cents": qtd_accrual,
        "top_outstanding": [
            {
                "invoice_id": inv.id,
                "number": inv.number,
                "amount_cents": inv.amount_cents,
                "days_overdue": (
                    max(0, (now - inv.due_at).days) if inv.due_at else 0
                ),
                "client_name": clients_by_id[inv.client_id].name if inv.client_id in clients_by_id else None,
            }
            for inv in top
        ],
        "avg_days_to_payment": avg_days,
        "last_synced_at": datetime.utcnow().isoformat() + "Z",
    }


@router.get("/dashboard/pipeline")
async def pipeline(db: Session = Depends(get_session)) -> dict[str, Any]:
    events = (
        db.execute(
            select(Event).where(
                Event.type.in_(
                    ["contract.sent_unsigned_5d", "contract.signed", "contract.declined"]
                )
            )
        )
        .scalars()
        .all()
    )
    sent = len(events)
    signed = sum(1 for e in events if e.type == "contract.signed")
    declined = sum(1 for e in events if e.type == "contract.declined")
    return {
        "sent": sent,
        "signed": signed,
        "declined": declined,
        "expected_revenue_cents": 0,
        "conversion_rate": signed / sent if sent else 0,
        "open_contracts": [
            {
                "id": e.id,
                "subject_ref": e.subject_ref,
                "type": e.type,
                "payload": e.payload,
            }
            for e in events
            if e.type == "contract.sent_unsigned_5d"
        ][:10],
    }


@router.get("/dashboard/utilization")
async def utilization() -> dict[str, Any]:
    from ..integrations.mocks import get_mock_store

    store = get_mock_store()
    entries = list(store.time_entries.values())
    total_hours = sum(e.hours for e in entries)
    today = datetime.utcnow().date()
    days = []
    for i in range(13, -1, -1):
        d = today - timedelta(days=i)
        days.append(d.isoformat())
    by_user: dict[str, dict[str, float]] = {}
    for e in entries:
        by_user.setdefault(e.user_id, {})
        by_user[e.user_id][e.date] = by_user[e.user_id].get(e.date, 0) + e.hours
    heatmap = [
        {"user_id": user, "daily": [m.get(d, 0) for d in days]}
        for user, m in by_user.items()
    ]
    return {
        "billable_pct": 100 if total_hours else 0,
        "logged_hours": round(total_hours),
        "retainer_cap_pct": 0,
        "heatmap": heatmap,
        "days": days,
    }


@router.get("/dashboard/projects")
async def projects(db: Session = Depends(get_session)) -> dict[str, Any]:
    rows = db.execute(select(Project)).scalars().all()
    clients = {c.id: c for c in db.execute(select(Client)).scalars().all()}
    now = datetime.utcnow()
    out = []
    for p in rows:
        days_silent = (
            (now - p.last_status_update_at).days if p.last_status_update_at else 999
        )
        pct = (p.hours_used / p.budget_hours) if (p.hours_used and p.budget_hours) else 0
        rag = "green"
        if pct >= 1.0 or days_silent > 14:
            rag = "red"
        elif pct >= 0.75 or days_silent > 7:
            rag = "amber"
        out.append(
            {
                "id": p.id,
                "name": p.name,
                "client_name": clients[p.client_id].name if p.client_id in clients else None,
                "owner": p.owner,
                "budget_hours": p.budget_hours,
                "hours_used": p.hours_used,
                "days_silent": days_silent,
                "budget_pct": round(pct * 100),
                "rag": rag,
            }
        )
    return {"projects": out}


@router.get("/dashboard/clients")
async def clients_endpoint(db: Session = Depends(get_session)) -> dict[str, Any]:
    rows = db.execute(select(Client)).scalars().all()
    invoices = db.execute(select(Invoice)).scalars().all()
    out = []
    for c in rows:
        ci = [i for i in invoices if i.client_id == c.id]
        lifetime = sum(i.amount_cents for i in ci if i.status == "paid")
        open_ar = sum(i.amount_cents for i in ci if i.status != "paid")
        out.append(
            {
                "id": c.id,
                "name": c.name,
                "tier": c.tier,
                "lifetime_cents": lifetime,
                "open_ar_cents": open_ar,
            }
        )
    return {"clients": out}
