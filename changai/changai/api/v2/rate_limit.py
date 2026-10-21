import time

import frappe
from frappe import _


def is_rate_limited(scope: str, limit: int = 10, window_sec: int = 60) -> bool:
    """Count one hit for the session user and report whether they are over the limit.

    Per-user fixed window in Redis. Frappe's @rate_limit is keyed by IP, which would
    make everyone behind one office connection share a single quota.
    """
    user = frappe.session.user
    window = int(time.time() // window_sec)
    key = frappe.cache.make_key(f"changai:rate_limit:{scope}:{user}:{window}")
    count = frappe.cache.incr(key)
    if count == 1:
        frappe.cache.expire(key, window_sec)
    return count > limit


def enforce_user_rate_limit(scope: str, limit: int = 10, window_sec: int = 60) -> None:
    if is_rate_limited(scope, limit, window_sec):
        frappe.throw(
            _("Too many requests. You can send up to {0} per minute; please wait a moment and try again.").format(limit),
            frappe.RateLimitExceededError,
            title=_("Slow down"),
        )
