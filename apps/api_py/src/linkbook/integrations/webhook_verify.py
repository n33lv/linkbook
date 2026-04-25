"""Webhook signature verification per source.

Each provider signs their webhook payload differently. Calling code at the
route boundary calls verify_<source>(req, body, secret) and rejects with
401 on mismatch.

Real-mode only — when USE_INTEGRATION_MOCKS=true the dev webhook routes
accept clean JSON without signatures (they're test fixtures).
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any


def verify_dropboxsign(api_key: str, raw_body: bytes, signature: str) -> bool:
    """Dropbox Sign signs payloads with HMAC SHA-256 keyed on the API key."""
    expected = hmac.new(api_key.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def verify_harvest(secret: str, raw_body: bytes, signature: str) -> bool:
    """Harvest webhooks sign as `sha256=<hex>` in the X-Harvest-Signature header."""
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    expected_header = f"sha256={expected}"
    return hmac.compare_digest(expected_header, signature)


def verify_airtable(secret: str, raw_body: bytes, mac: str) -> bool:
    """Airtable webhook MAC is HMAC-SHA256 over the raw JSON body."""
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, mac)


def verify_pubsub_jwt(token: str, expected_audience: str) -> dict[str, Any] | None:
    """Verify the Google Cloud Pub/Sub push JWT.

    For full real-mode, validate against Google's public certs at
    https://www.googleapis.com/oauth2/v3/certs and check `iss=https://accounts.google.com`,
    `aud=<configured>`. Returning None means rejected.

    NOTE: stub implementation. Replace with `google-auth` library lookup
    when wiring real Pub/Sub.
    """
    # In dev with mocks the route receives clean JSON; in prod we must
    # do this properly. The function exists so call sites can already
    # invoke it without a refactor.
    if not token or not expected_audience:
        return None
    # TODO(integration:gmail): real JWT verification
    return None


# QBO doesn't sign its CDC payloads — no verification needed for poll-based
# integrations. Their security relies on OAuth bearer tokens we hold.
