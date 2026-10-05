# API

JSON over HTTP. Base path `/api`. Request and response bodies are `application/json`.
Times in responses are ISO-8601 UTC strings. Money is integer minor units (`*_cents`). Ids are strings (DATA_MODEL §1).

## Conventions
- **Auth headers:** `x-admin-key` (admin), `x-gate-key` (gate), `x-hold-token` (buyer, for a hold/order), `x-queue-token` (queue).
- **Error body (all errors):**
```json
{ "error": { "code": "SOLD_OUT", "message": "Not enough tickets left", "details": { "scope": "event" } } }
```
- **Idempotency:** `pay` on an already-paid hold returns the existing order (`200`). Queue `join` for a live entry returns it unchanged (`200`).
- **No caching:** availability is computed per request.

## Who may call what
| Route | Caller | Credential |
|---|---|---|
| `GET /health`, `GET /api/events`, `GET /api/events/:eventId` | anyone | none |
| `POST /api/events/:eventId/queue` | buyer | none |
| `GET /api/events/:eventId/queue` | the buyer who joined | `x-queue-token` |
| `POST /api/events/:eventId/holds` | buyer | `x-queue-token` when the event has the queue enabled; otherwise none |
| `GET /api/holds/:holdId`, `DELETE /api/holds/:holdId`, `POST /api/holds/:holdId/pay`, `GET /api/orders/:orderId`, `GET /api/tickets/:ticketId/qr.svg` | the buyer who created the hold | `x-hold-token` |
| `POST /api/checkin` | gate staff | `x-gate-key` |
| every `/api/admin/*` route | organiser | `x-admin-key` |

## Error codes
| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed body / parameters |
| 401 | `UNAUTHORIZED` | Missing or wrong admin/gate key |
| 403 | `FORBIDDEN` | Wrong hold/queue token |
| 403 | `NOT_ADMITTED` | Queue enabled and admission missing/expired/for another email (`details.reason`: `WAITING`, `EXPIRED`, `EMAIL_MISMATCH`, `UNKNOWN_TOKEN`) |
| 404 | `NOT_FOUND` | Unknown event/tier/hold/order |
| 404 | `INVALID_QR` | Unknown or malformed QR |
| 402 | `PAYMENT_FAILED` | Mock payment declined (hold stays active) |
| 409 | `SOLD_OUT` | `details.scope` = `tier` or `event` |
| 409 | `SALE_NOT_OPEN` | Tier outside its sale window |
| 409 | `BUYER_LIMIT` | `details`: `limit`, `used`, `requested` |
| 409 | `HOLD_NOT_ACTIVE` | Hold released or otherwise closed |
| 409 | `ALREADY_CHECKED_IN` | `details`: `checked_in_at`, `gate` |
| 409 | `TICKET_VOID` | Ticket refunded |
| 409 | `TICKET_CHECKED_IN` | Refund refused: already admitted |
| 409 | `ALREADY_REFUNDED` | Ticket already void |
| 409 | `QUEUE_NOT_ENABLED` | Event has no waiting room |
| 410 | `HOLD_EXPIRED` | Hold expired |
| 422 | `PROMO_INVALID` | `details.reason`: `NOT_FOUND`, `NOT_STARTED`, `EXPIRED`, `EXHAUSTED`, `NOT_APPLICABLE` |
| 422 | `MAX_PER_ORDER` | Quantity above tier `max_per_order` |
| 500 | `INTERNAL` | Unexpected failure; the cause is logged, never returned |

## Public

### `GET /health`
`200` → `{ "ok": true, "time": "2026-10-06T12:30:00.000Z" }`

### `GET /api/events/:eventId`
Event, tiers and live availability.
```json
{
  "event": { "id": "evt_x", "name": "Fest 2026", "starts_at": "2026-10-20T13:00:00.000Z",
             "capacity": 5000, "sold": 120, "held": 30, "available": 4850, "queue_enabled": true },
  "tiers": [
    { "id": "tier_a", "name": "Early", "price_cents": 49900, "capacity": 1000, "sold": 100, "held": 10,
      "available": 890, "max_per_order": 6, "sale_starts_at": null, "sale_ends_at": null }
  ],
  "currency": "INR"
}
```
`tier.available` already applies the pool: `min(tier.capacity − sold − held, event.capacity − sold − held)`.

### `GET /api/events` → `200 { "events": [ { id, name, starts_at, available } ] }`

### `POST /api/events/:eventId/queue`  *(waiting room join)*
Body `{ "email": "a@b.com" }`. `201` new entry, `200` existing live entry.
```json
{ "queue_token": "k3J9…", "status": "WAITING", "position": 42, "ahead": 41, "eta_seconds": 4, "admit_expires_at": null }
```
Errors: `409 QUEUE_NOT_ENABLED`, `400`.

### `GET /api/events/:eventId/queue`  *(poll)*  header `x-queue-token`
`200` → `{ "status": "ADMITTED", "position": 0, "ahead": 0, "eta_seconds": 0, "admit_expires_at": "…Z", "sold_out": false }`
Status is one of `WAITING | ADMITTED | USED | EXPIRED`. `403 FORBIDDEN` for a wrong token.

### `POST /api/events/:eventId/holds`  *(reserve)*
Headers: `x-queue-token` (required when the event has the queue enabled).
```json
{ "email": "student@college.edu",
  "items": [ { "tier_id": "tier_a", "quantity": 2 } ],
  "promo_code": "FRESHER10" }
```
`201`:
```json
{ "hold": { "id": "hold_x", "status": "ACTIVE", "event_id": "evt_x", "email": "student@college.edu",
            "items": [ { "tier_id": "tier_a", "quantity": 2, "unit_price_cents": 49900 } ],
            "subtotal_cents": 99800, "discount_cents": 9980, "total_cents": 89820,
            "expires_at": "2026-10-20T12:40:00.000Z", "expires_in_seconds": 600 },
  "hold_token": "q1Zr…" }
```
Errors: `400`, `403 NOT_ADMITTED`, `404`, `409 SOLD_OUT | SALE_NOT_OPEN | BUYER_LIMIT`, `422 MAX_PER_ORDER | PROMO_INVALID`.
Nothing is consumed on any error.

### `GET /api/holds/:holdId`  header `x-hold-token`
`200` → `{ "hold": { …as above, "status": "ACTIVE|CONVERTED|EXPIRED|RELEASED", "seconds_left": 312 } }`

### `DELETE /api/holds/:holdId`  header `x-hold-token`  *(release)*
`200` → `{ "hold": { "id": "hold_x", "status": "RELEASED" } }`. `409 HOLD_NOT_ACTIVE` otherwise.

### `POST /api/holds/:holdId/pay`  header `x-hold-token`
Body `{ "payment_method": "mock", "simulate": "success" }` (`simulate` may be `success` or `decline`; default `success`).
`201` (first time) or `200` (replay):
```json
{ "order": { "id": "ord_x", "status": "PAID", "total_cents": 89820, "refunded_cents": 0, "paid_at": "…Z" },
  "tickets": [ { "id": "tkt_1", "tier_id": "tier_a", "status": "VALID", "qr_payload": "AP1:Vf0l…" },
               { "id": "tkt_2", "tier_id": "tier_a", "status": "VALID", "qr_payload": "AP1:9aQm…" } ] }
```
Errors: `402 PAYMENT_FAILED` (hold remains active), `403`, `404`, `409 HOLD_NOT_ACTIVE`, `410 HOLD_EXPIRED`.

### `GET /api/orders/:orderId`  header `x-hold-token` (token of the originating hold)
`200` → `{ "order": {…}, "tickets": [ {…, "status": "VALID|CHECKED_IN|VOID"} ] }`

### `GET /api/tickets/:ticketId/qr.svg`  header `x-hold-token`  *(optional)*
`200` `image/svg+xml` rendering `qr_payload`.

## Gate

### `POST /api/checkin`  header `x-gate-key`
```json
{ "qr": "AP1:Vf0l…", "gate": "north-1" }
```
`gate` is optional (a name of up to 64 characters, stored with the scan); whitespace around `qr` is ignored.
`200`:
```json
{ "result": "ADMITTED", "ticket": { "id": "tkt_1", "tier_id": "tier_a", "tier_name": "Early", "event_id": "evt_x" },
  "checked_in_at": "2026-10-20T13:02:11.000Z" }
```
Refusals (every attempt is written to `scan_log`):
- `409 ALREADY_CHECKED_IN` — `details: { "checked_in_at": "…Z", "gate": "north-1" }`
- `409 TICKET_VOID`
- `404 INVALID_QR`
- `401 UNAUTHORIZED`

## Admin  (header `x-admin-key`)

### `POST /api/admin/events`
`{ "name": "Fest 2026", "starts_at": "2026-10-20T13:00:00Z", "capacity": 5000, "queue_enabled": true }` → `201 { "event": {…} }`

### `POST /api/admin/events/:eventId/tiers`
`{ "name": "Early", "price_cents": 49900, "capacity": 1000, "max_per_order": 6, "sale_starts_at": null, "sale_ends_at": null }` → `201 { "tier": {…} }`
(`max_per_order` defaults to `DEFAULT_MAX_PER_ORDER`.)

### `POST /api/admin/events/:eventId/promo-codes`
`{ "code": "FRESHER10", "kind": "PERCENT", "value": 10, "max_uses": 200, "valid_from": null, "valid_to": null, "tier_id": null }` → `201 { "promo": {…} }`
(`code` is stored lower-case; lookups are case-insensitive.)

### `PATCH /api/admin/events/:eventId`
`{ "queue_enabled": true|false }` → `200 { "event": {…} }`

### `GET /api/admin/events/:eventId/stats`
```json
{ "event": { "capacity": 5000, "sold": 120, "held": 30, "available": 4850 },
  "tiers": [ { "id": "tier_a", "capacity": 1000, "sold": 100, "held": 10, "available": 890 } ],
  "tickets": { "VALID": 90, "CHECKED_IN": 10, "VOID": 0 },
  "holds": { "ACTIVE": 12, "CONVERTED": 50, "EXPIRED": 7, "RELEASED": 1 },
  "queue": { "WAITING": 300, "ADMITTED": 25, "USED": 400, "EXPIRED": 20 },
  "invariants": { "ok": true, "mismatches": [] } }
```

### `POST /api/admin/orders/:orderId/refund`
`{ "ticket_ids": ["tkt_1"], "reason": "student request" }` (omit `ticket_ids` to refund all). `200`:
```json
{ "order": { "id": "ord_x", "status": "PARTIALLY_REFUNDED", "refunded_cents": 44910 },
  "voided_ticket_ids": ["tkt_1"], "refunded_cents": 44910 }
```
Errors: `404`, `409 TICKET_CHECKED_IN | ALREADY_REFUNDED`.

### `POST /api/admin/sweep` and `POST /api/admin/queue/tick`  *(operational/test helpers)*
Run the hold sweeper and one admission tick immediately. `200 { "expired": 3 }` / `200 { "admitted": 25 }`.

## Worked example (the three Killer Tests over HTTP)
1. `POST /api/admin/events` (capacity 1) → `evt_x`; `POST …/tiers` (capacity 1) → `tier_a`.
2. **KT1:** two clients `POST /api/events/evt_x/holds` simultaneously with `quantity: 1` → one `201`, one `409 SOLD_OUT`.
3. **KT2:** set `HOLD_TTL_SECONDS=1`; the loser retries after 1.5 s → `201`; the first hold's `pay` → `410 HOLD_EXPIRED`.
4. **KT3:** `POST /api/holds/:id/pay` → ticket `qr_payload`; `POST /api/checkin` twice → `200 ADMITTED`, then `409 ALREADY_CHECKED_IN`.
