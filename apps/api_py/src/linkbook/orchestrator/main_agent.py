"""Top-level orchestrator. Strategy.HANDOFF over the five sub-agents.

The LLM picks which specialist runs for the given prompt. For a single
action's worth of work the prompt is structured (built by execute.py
from the action's type + params); for ad-hoc free-form prompts the
orchestrator naturally routes by content.
"""

from __future__ import annotations

from agentspan.agents import Agent, Strategy

from ..config import load_config
from .airtable_agent import build_airtable_agent
from .dropboxsign_agent import build_dropboxsign_agent
from .gmail_agent import _resolve_model, build_gmail_agent
from .harvest_agent import build_harvest_agent
from .qbo_agent import build_qbo_agent

_INSTRUCTIONS = """\
You are the operations orchestrator for a small creative studio (1–10 people).
The studio runs Linkbook on top of QuickBooks, Harvest, Dropbox Sign,
Airtable, and Gmail. Source of truth always lives in the source system.

Your job is to route the work to the right specialist:
  - gmail        — sending email, applying labels
  - qbo          — invoice status reads, payment apply, mark paid, void
  - harvest      — sending invoices, creating projects, logging time
  - dropboxsign  — sending or reminding contracts
  - airtable     — reading + writing project records

Hard constraints:
  - You never invent IDs, recipients, or amounts. The action params
    contain the exact values. Pass them through.
  - You never write to QuickBooks journal entries.
  - Composite work (e.g. project kickoff: harvest project + airtable
    record + drive folder + welcome email) is dispatched leg-by-leg —
    the caller will hand you one leg at a time.
  - When unsure, return a short clarification instead of guessing.
"""


def build_orchestrator() -> Agent:
    cfg = load_config()
    model = _resolve_model(cfg)
    return Agent(
        name="orchestrator",
        model=model,
        instructions=_INSTRUCTIONS,
        agents=[
            build_gmail_agent(),
            build_qbo_agent(),
            build_harvest_agent(),
            build_dropboxsign_agent(),
            build_airtable_agent(),
        ],
        strategy=Strategy.HANDOFF,
    )
