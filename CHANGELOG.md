# Changelog

## v3.2.0 — Free-first and multi-user safety

- Paid/cheap/premium routes require `pricingVerified: true` plus valid input/output price values before use. Default paid routes stay disabled until their prices are verified.
- `auto-heavy` now tries free large models first, then cheap, then premium.
- Automatic discovery no longer treats missing price metadata as proof that a model is free. Unknown-price models stay `unverified_free`; explicitly priced models stay `not_free`. Operators can opt in per provider with `discover.assumeFree: true` only after checking that account/provider's terms.
- Shared-account 429s trigger provider-wide cooldown rather than trying alternate keys. Groq and OpenRouter are configured as shared-quota providers.
- Added optional per-user RPM and daily paid budget keyed by an HMAC of `X-User-ID` supplied only by the authenticated application backend. `web` and `mobile` require this header in the default config; keep `USER_ID_HASH_SECRET` stable across restarts.
- Sensitive routes default to unverified privacy; operator must verify provider terms before setting `privacy: "private"`.
- Strict Bearer auth, production secret-length checks, conservative token estimates, budget-estimate overrun logging.
- Added Docker Compose for Ubuntu/VPS with Postgres, local-only default port binding, and WireGuard-bind option. Docker image now runs as non-root.
- Expanded tests for unknown-price discovery, paid route pricing gate, per-user limits/budgets, and shared-account 429 handling.
