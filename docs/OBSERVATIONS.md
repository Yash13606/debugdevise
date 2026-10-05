# OBSERVATIONS — how Hi.Events handles capacity, holds, check-in, promo codes and refunds

| | |
|---|---|
| Original | https://github.com/HiEventsDev/Hi.Events |
| Commit studied | `af22b01c5f3737dd6ae678ebc53ef66e9a6b4955` (2 Oct 2026, "Feature: Box Office & Seating (#1372)"), `VERSION` = 2.0.0-alpha.1 |
| Stack | PHP/Laravel backend (`backend/`), PostgreSQL, React frontend (`frontend/`) |
| Method | Static reading and text search of the source. **Nothing was executed or reproduced.** |
| Paths | Relative to the original's repo root. Line numbers refer to the commit above. |

**Tags.** **[R]** = stated directly at the cited line(s). **[A]** = our analysis combining several cited lines; not run.
Code is described in words only; none of it is reproduced here.

## 1. Quick answers

| Question | Answer | See |
|---|---|---|
| How does it stop two buyers taking the last ticket? | Order creation runs in one DB transaction whose first statement takes a per-event Postgres advisory lock; availability is recomputed inside it. | CAP-2, CAP-3 |
| What is a "hold"? | An ordinary order row with status `RESERVED` and a `reserved_until` timestamp. No separate hold table and no `held` counter. | HOLD-1 |
| How long does a hold last? | Per-event setting `order_timeout_in_minutes`: default 15, allowed 1–120, whole minutes. | HOLD-2 |
| What frees an unpaid hold? | Nothing runs. Every query that counts holds filters on `reserved_until > now`, so an expired hold simply stops counting. The row stays `RESERVED`. | HOLD-3, HOLD-4 |
| What if the payment arrives after expiry? | The Stripe webhook detects the expiry and refunds automatically; non-seated orders are never rescued. | PAY-4 |
| When is "sold" counted? | At completion events (free completion, payment webhook, offline-payment selection, box office, organiser edits), by an unguarded increment. Not at reservation. | CAP-6 |
| What does the QR code contain? | The attendee's `public_id`, as plain text. Unsigned. | CHK-1 |
| How is a double check-in prevented? | Scanner path: unique partial index plus catching the violation. Admin API path: read-then-write, not atomic. | CHK-2, CHK-3 |
| How are promo limits enforced? | Live count of orders holding the code, taken inside the event lock. An exhausted code is silently dropped. | PROMO-2, PROMO-3 |
| What does a refund do to capacity? | Cancelling an order decrements sold counters and cancels attendees (QR dead). A Stripe refund cancels only if `cancel_order` is set. | REF-1 to REF-3 |
| What is rate-limited? | Order creation 60/min/IP, promo lookup 10/min/IP, general API 180/min/IP (defaults). | LIM-1 |

## 2. Capacity and the last ticket

**CAP-1 [R] Two validation layers.** The public create-order action first runs an *unlocked* pre-check (`backend/app/Http/Actions/Orders/Public/CreateOrderActionPublic.php:44` → `backend/app/Services/Domain/Order/OrderCreateRequestValidationService.php:54-77`). It checks types (`:253-270`), promo existence (`:218-236`), non-empty selection (`:275-283`), add-ons (`:288-323`), occurrence (`:328-356`), per-product rules (`:385-443`): visibility (`:469-479`), sale window (`:543-560`), min/max per order with a default maximum of 100 (`:484-531`, default at `:489`), sold-out (`:591-601`), valid/locked price tier (`:606-655`), and shared-pool capacity (`:702-745`). Then the locked handler runs (`CreateOrderActionPublic.php:48`).

**CAP-2 [R] Per-event advisory lock.** `backend/app/Services/Application/Handlers/Order/CreateOrderHandler.php:61` opens a transaction; the first statement (`:62`) acquires the lock via `backend/ee/Seating/Services/Domain/SeatingEventLockService.php:17-22` → `backend/app/Services/Infrastructure/Lock/TransactionLockService.php:21-27`, which issues a transaction-scoped Postgres advisory lock keyed by a fixed keyspace constant (`:11`) and the event id reduced modulo 2147483647 (`:25`; constant defined at `:15`). The class lives in the `ee/Seating` namespace but the call is unconditional, so it covers every event. A unit test asserts the lock is taken before order creation (`backend/tests/Unit/Services/Application/Handlers/Order/CreateOrderHandlerTest.php:106-112`). Manual attendee creation (`backend/app/Services/Application/Handlers/Attendee/CreateAttendeeHandler.php:98-99`) and box-office order creation (`backend/ee/BoxOffice/Services/Application/Handlers/Public/CreateBoxOfficeOrderPublicHandler.php:47`) take the same lock.

**CAP-3 [R] What runs inside the lock.** In order: load event and settings (`CreateOrderHandler.php:64-66`); event must be live unless the caller is authenticated (`:68`, `:136-143`); delete this browser session's earlier `RESERVED` orders (`:70-72`, `backend/app/Services/Domain/Order/OrderManagementService.php:25-32`); resolve promo (`:74`, `:105-121`); recompute availability and reject when requested exceeds available (`:77`, `:148-182`, `:187-221`; throw at `:214-218`); create the `RESERVED` order (`:79-87`); create order items (`:89-94`); claim seats (`:96`); update totals (`:98-101`). Availability for this step bypasses the cache (`:157`).

**CAP-4 [R] Availability formula.** Per price tier: `initial_quantity_available − quantity_sold − live reserved`, floored at 0; a null initial quantity means unlimited (`backend/app/Services/Domain/Product/AvailableProductQuantitiesFetchService.php:280-282`, columns selected at `:250-266`). "Live reserved" is the sum of order-item quantities for orders that are `RESERVED`, have `reserved_until` in the future, and are not soft-deleted (`:268` → `backend/app/Services/Domain/Product/SoldAndReservedQuantitiesService.php:19-22` → `backend/app/Repository/Eloquent/OrderItemRepository.php:35-45`, filter at `:81-88`).

**CAP-5 [R] Shared capacity pools.** A "capacity assignment" caps several products together. The per-product figure becomes the minimum of the tier availability and the pool's `capacity − used_capacity` (`AvailableProductQuantitiesFetchService.php:75-83`; `backend/app/DomainObjects/CapacityAssignmentDomainObject.php:78-85`). **Live holds are not subtracted from the pool in this figure.** The only code that subtracts them is the unlocked pre-check (`OrderCreateRequestValidationService.php:722-731`). Occurrence capacity *does* subtract holds (`AvailableProductQuantitiesFetchService.php:231`).

**CAP-6 [R] When "sold" is counted.** `product_prices.quantity_sold`, pool `used_capacity` and occurrence `used_capacity` are not touched at reservation. They are raised by an unguarded `+ N` update (`backend/app/Services/Domain/Product/ProductQuantityUpdateService.php:38-42`, pool `:99-106`, occurrence `:117-124`) when: a free order completes (`backend/app/Services/Application/Handlers/Order/CompleteOrderHandler.php:106-108`); the Stripe `payment_intent.succeeded` webhook is handled (`backend/app/Services/Domain/Payment/Stripe/EventHandlers/PaymentIntentSucceededHandler.php:166`); offline payment is chosen (`backend/app/Services/Application/Handlers/Order/TransitionOrderToOfflinePaymentHandler.php:76`); box-office completion (`backend/ee/BoxOffice/Services/Domain/BoxOfficeOrderCompletionService.php:99`); organiser attendee create/edit (`CreateAttendeeHandler.php:368`, `backend/app/Services/Application/Handlers/Attendee/EditAttendeeHandler.php:69-70`, `PartialEditAttendeeHandler.php:152,162`). Decrements are clamped at zero (`ProductQuantityUpdateService.php:60`) and happen on order cancel (`backend/app/Services/Domain/Order/OrderCancelService.php:129,154`) and occurrence cancel (`backend/app/Services/Domain/EventOccurrence/CancelOccurrenceAttendeesService.php:84`).

**CAP-7 [A] No atomic hold→sold step.** Because there is no `held` counter, capacity safety rests on (a) the event lock at reservation and (b) time-based filtering of holds. Converting a hold to a sale (CAP-6) is a separate transaction that does not re-check capacity.

**CAP-8 [R] Availability cache.** Public availability may be cached; default TTL 2 seconds (`backend/config/app.php:52`; `AvailableProductQuantitiesFetchService.php:50-55,112-114`). Order creation bypasses it.

## 3. Holds and expiry

**HOLD-1 [R] Representation.** A hold is the order itself: `status = RESERVED`, `reserved_until = now + timeout` (`OrderManagementService.php:43,48-49`). The timeout comes from event settings (`CreateOrderHandler.php:82`).

**HOLD-2 [R] Timeout setting.** Column `order_timeout_in_minutes` defaults to 15 (`backend/database/migrations/schema.sql:706`), validated numeric, min 1, max 120 (`backend/app/Http/Request/EventSettings/UpdateEventSettingsRequest.php:30`).

**HOLD-3 [R] Expiry is enforced at read time.** The same "reserved and `reserved_until` in the future" filter is used for capacity (`OrderItemRepository.php:81-88`), promo usage (`backend/app/Repository/Eloquent/OrderRepository.php:220-223`), the product has-orders guard (`backend/app/Repository/Eloquent/ProductRepository.php:284-289`) and box-office listings (`OrderRepository.php:300-304`).

**HOLD-4 [R] There is no expiry job.** The scheduler runs only scheduled messages, expired *waitlist* offers, account deletions and a failed-jobs monitor (`backend/app/Console/Kernel.php:22-34`; a search of `backend/app` and `backend/ee` for scheduling calls finds only those). `backend/app/Jobs/Order/` holds only email and webhook jobs, and `backend/app/Console/Commands/` has no order-expiry command. Expired holds stay `RESERVED` and no state change or event is produced.

**HOLD-5 [R] Waitlist trigger.** Waitlist processing is driven by `CapacityChangedEvent` (`backend/app/Listeners/Waitlist/ProcessWaitlistOnCapacityAvailableListener.php:25`). It is dispatched from exactly eleven files in `backend/app` (order cancel, attendee edit, product edit, capacity-assignment update/delete, event settings, waitlist cancel, expired waitlist offers, occurrence cancel, waitlist offer revert); `backend/ee` has none. Neither hold expiry nor abandon dispatches it.

**HOLD-6 [R] Using an expired hold is refused.** Complete: `CompleteOrderHandler.php:356-358` (inside `validateOrder`, `:350-363`). Create payment intent: `backend/app/Services/Application/Handlers/Order/Payment/Stripe/CreatePaymentIntentHandler.php:70-72`. Abandon: `backend/app/Services/Application/Handlers/Order/Public/AbandonOrderPublicHandler.php:72-74`. Offline payment: `TransitionOrderToOfflinePaymentHandler.php:120`.

**HOLD-7 [R] Explicit release.** Abandon takes the per-order lock and sets `ABANDONED` (`AbandonOrderPublicHandler.php:32-55`); it dispatches no capacity event. Creating a new order in the same browser session deletes the previous `RESERVED` one (`OrderManagementService.php:25-32`, `CreateOrderHandler.php:70-72`).

**HOLD-8 [R] No hold extension on payment start.** `CreatePaymentIntentHandler.php:58-110` never writes `reserved_until`. The only place that sets a new value is the box-office card-terminal flow (`backend/ee/BoxOffice/Services/Domain/Payment/Stripe/Terminal/StripeTerminalPaymentService.php:106`).

## 4. Completing and paying

**PAY-1 [R] Free order.** Under a per-order lock (`CompleteOrderHandler.php:90`) the order becomes `COMPLETED` with payment status `NO_PAYMENT_REQUIRED` (`:405-410`), attendees are `ACTIVE` (`:194-196`) and sold counters rise (`:106-108`).

**PAY-2 [R] Paid order.** Completion leaves the order `RESERVED` with payment `AWAITING_PAYMENT` and attendees `AWAITING_PAYMENT` (`CompleteOrderHandler.php:194-196,405-410`) until the payment webhook.

**PAY-3 [R] Webhook success.** `PaymentIntentSucceededHandler.php:115-178`: order lock (`:134`); idempotency checks (`:136-138`, in-cache marker for one hour `:405-420`); duplicate/other-payment guards (`:142-156`); validation (`:158`, `:342-390`); order → `COMPLETED`/`PAYMENT_RECEIVED` (`:212-220`); attendees → `ACTIVE` (`:392-403`); sold counters raised (`:166`). The handler takes the *order* lock, not the event lock, and does not re-check capacity before raising counters.

**PAY-4 [R] Late payment.** If `reserved_until` has passed, the handler raises "not completable" (`:254-282`, `:287-293`) and refunds automatically (`:305-336`). A non-seated order can never be rescued (`backend/ee/Seating/Services/Domain/SeatedOrderCompletionGuard.php:61-65`). Cancelled or abandoned orders are refunded too (`PaymentIntentSucceededHandler.php:366-376`).

## 5. QR check-in

**CHK-1 [R] QR content.** The ticket component renders the attendee `public_id` as plain text in a QR (`frontend/src/components/common/AttendeeTicket/index.tsx:155-156`). Format: prefix `A`, a dash, seven random characters, upper-cased (`backend/app/Helper/IdHelper.php:34-37`); created at `CompleteOrderHandler.php:201`. There is no signature or expiry.

**CHK-2 [R] Scanner path (race-safe).** `POST /public/check-in-lists/{short_id}/check-ins` (`backend/routes/api.php:807`, inside the public group `:714-833`, no auth middleware; the list's short id is the only credential) → `backend/app/Services/Application/Handlers/CheckInList/Public/CreateAttendeeCheckInPublicHandler.php:27-53` → `backend/app/Services/Domain/CheckInList/CreateAttendeeCheckInService.php:44-64`. Gates: list active window (`:50`; list has `activates_at`/`expires_at`, `backend/app/DomainObjects/CheckInListDomainObject.php:94-99`); every scanned code must exist (`backend/app/Services/Domain/CheckInList/CheckInListDataService.php:65-84`); attendee must belong to the list's products, event and occurrence (`:26-57`); cancelled attendees refused (`CreateAttendeeCheckInService.php:220-224`); awaiting-payment attendees refused unless the event allows it (`:226-240`). Duplicates are handled twice: a soft pre-check against existing check-in rows (`:54,93-105,165-172`) and a database-enforced partial unique index on `(attendee_id, check_in_list_id)` where `deleted_at` is null (`backend/database/migrations/2026_07_20_000002_add_unique_attendee_check_in_index.php:22-26`, which first soft-deletes older duplicates `:10-20`). The insert runs in a transaction (`:179-192`) and a unique-violation is caught and reported as "already checked in" (`:193-203`).

**CHK-3 [R] Admin API path (not atomic).** `POST /events/{event_id}/attendees/{attendee_public_id}/check_in` (`backend/routes/api.php:518`, authenticated) → `backend/app/Http/Actions/Attendees/CheckInAttendeeAction.php:21-36` → `backend/app/Services/Application/Handlers/Attendee/CheckInAttendeeHandler.php:29-39`. It fetches the attendee (`:31,41-55`), requires `ACTIVE` (`:60-73`), rejects when `checked_in_at` is already set (`:78-102`), then runs an **unconditional** update keyed by `public_id` and `event_id` (`:104-123`). **[A]** Two simultaneous requests can both pass the read and both succeed; the second overwrites the first. This path writes `attendees.checked_in_at`, whereas CHK-2 writes `attendee_check_ins`; neither consults the other, so one attendee can be admitted once per path.

**CHK-4 [R] Legacy column still present.** The 2024 migration comments that the old attendee columns would be dropped later (`backend/database/migrations/2024_08_08_032637_create_check_in_lists_tables.php:73-78`); they still exist (`backend/app/DomainObjects/Generated/AttendeeDomainObjectAbstract.php:17-18,27`). The frontend API client defines the admin check-in call (`frontend/src/api/attendee.client.ts:56-57`); we found no mutation hook that uses it **[A]**.

**CHK-5 [R] Refund/cancel kills the QR.** Cancelling an order sets attendees `CANCELLED` (`OrderCancelService.php:98-108`); both check-in paths refuse them (`CheckInAttendeeHandler.php:62-72`, `CreateAttendeeCheckInService.php:220-224`).

## 6. Promo codes

**PROMO-1 [R]** Lookup is lower-cased, trimmed and scoped to the event (`CreateOrderHandler.php:111-114`; pre-check `OrderCreateRequestValidationService.php:224-236`).

**PROMO-2 [R] Limit enforcement.** The count of orders holding the code = `COMPLETED` + `AWAITING_OFFLINE_PAYMENT` + unexpired `RESERVED` (`backend/app/Services/Domain/PromoCode/PromoCodeUsageValidationService.php:19-32` → `OrderRepository.php:212-230`), evaluated inside the event lock (`CreateOrderHandler.php:74`). The stored `order_usage_count` is updated asynchronously (docblock `PromoCodeUsageValidationService.php:14-18`; `backend/app/Services/Domain/EventStatistics/EventStatisticsIncrementService.php:60,404`).

**PROMO-3 [R] Silent drop.** If the code is invalid or exhausted at that point it is ignored and the order continues at full price (`CreateOrderHandler.php:116-118`); the pre-check does the same for an invalid-but-existing code (`OrderCreateRequestValidationService.php:235`). Only a non-existent code produces an error (`:229-233`).

**PROMO-4 [R]** `max_allowed_usages` is optional, ≥1, ≤9,999,999 (`backend/app/Http/Request/PromoCode/CreateUpdatePromoCodeRequest.php:28`). The preview endpoint is throttled (`backend/routes/api.php:761-762`).

## 7. Cancel and refunds

**REF-1 [R] Cancel.** `backend/app/Services/Application/Handlers/Order/CancelOrderHandler.php:29-61`: transaction, guard "already cancelled" (`:42-44`) with **no lock**, then `OrderCancelService::cancelOrder` (`:46`). The service (`OrderCancelService.php:47-74`) decrements statistics (`:50`), lowers sold counters for attendees that are `ACTIVE` (or also `AWAITING_PAYMENT` for offline orders) (`:110-137`), restores non-ticket items (`:139-159`), sets attendees `CANCELLED` (`:98-108`), sets the order `CANCELLED` (`:161-171`), reverts waitlist offers (`:55`), emails the buyer (`:57`, `:76-96`) and dispatches `CapacityChangedEvent` per product/occurrence (`:173-194`).

**REF-2 [R] Dispatch.** Offline vs Stripe by payment provider (`backend/app/Services/Application/Handlers/Order/RefundOrderHandler.php:42-46`).

**REF-3 [R] Stripe refund.** `backend/app/Services/Application/Handlers/Order/Payment/Stripe/RefundOrderHandler.php:120-151`. Refused if no Stripe payment exists or a refund is pending (`:73-85`). **The order (and so capacity) is cancelled only when `cancel_order` is true** (`:132-134`). It then calls Stripe (`:140-144`) and marks `refund_status = REFUND_PENDING` (`:150`). A partial refund without `cancel_order` leaves capacity and the QR untouched.

## 8. Data model observed

Current schema = baseline `backend/database/migrations/schema.sql` (still uses `tickets`/`ticket_prices`) plus migrations, e.g. rename to `products`/`product_prices` (`backend/database/migrations/2024_09_20_032323_rename_tickets_to_products.php`). Columns below come from generated domain objects and `backend/docs/database-schema.md`.

| Table | Notable columns (source) |
|---|---|
| `event_settings` | `order_timeout_in_minutes` int default 15 (`schema.sql:706`) |
| `products` (ticket tiers) | `event_id`, title, `product_type`, `min_per_order`, `max_per_order`, sale start/end, hidden flags (`database-schema.md:176-198`) |
| `product_prices` | `product_id`, `price`, `label`, sale start/end, `initial_quantity_available` (null = unlimited), `quantity_sold`, `is_hidden`, `quantity_applies_to` (`backend/app/DomainObjects/Generated/ProductPriceDomainObjectAbstract.php:13-27`) |
| `capacity_assignments` | `capacity`, `used_capacity`, `applies_to`, `status` (`AvailableProductQuantitiesFetchService.php:62-68`; `ProductQuantityUpdateService.php:99-115`) |
| `orders` | `status`, `payment_status`, `refund_status`, `reserved_until`, `session_id`, `promo_code_id`, totals, `short_id`, `public_id` (`backend/app/DomainObjects/Generated/OrderDomainObjectAbstract.php:13-53`) |
| `order_items` | `order_id`, `product_id`, `product_price_id`, `quantity`, price fields, `event_occurrence_id` (`database-schema.md:280-299`; `backend/app/Services/Domain/Order/OrderItemProcessingService.php:242-258`) |
| `attendees` | `order_id`, `product_id`, `public_id` (QR), `short_id`, `status`, legacy `checked_in_at` / `checked_in_by` / `checked_out_by` (`AttendeeDomainObjectAbstract.php:13-34`) |
| `check_in_lists`, `ticket_check_in_lists`, `attendee_check_ins` | list window and product join; one row per admitted attendee per list, unique partial index (`2024_08_08_032637_create_check_in_lists_tables.php:12-71`; `2026_07_20_000002_...:22-26`) |
| `promo_codes` | `code`, `max_allowed_usages`, `order_usage_count`, `attendee_usage_count` (`backend/app/Resources/PromoCode/PromoCodeResource.php:26-28`) |
| `stripe_payments` | `order_id`, `payment_intent_id`, `charge_id`, `amount_received` (`database-schema.md:301-315`) |

Index seen: `(event_id, status, reserved_until, deleted_at)` on orders (`backend/database/migrations/2024_07_19_033929_add_missing_indexes.php:12`). IDs: short ids are prefix + `_` + 13 random characters; public ids are prefix + `-` + 7 random characters, upper-cased (`IdHelper.php:29-37`).

**State sets.** Order status: `RESERVED, COMPLETED, CANCELLED, ABANDONED, AWAITING_OFFLINE_PAYMENT` (`backend/app/DomainObjects/Status/OrderStatus.php:11-15`). Payment status: `NO_PAYMENT_REQUIRED, AWAITING_PAYMENT, AWAITING_OFFLINE_PAYMENT, PAYMENT_FAILED, PAYMENT_RECEIVED` (`OrderPaymentStatus.php:7-11`). Attendee status: `ACTIVE, AWAITING_PAYMENT, CANCELLED` (`AttendeeStatus.php:11-13`).

## 9. Limits and throttling

**LIM-1 [R]** Limiters are defined in `backend/app/Providers/RouteServiceProvider.php:29-69`. Defaults: general API 180/min (`backend/config/app.php:27`), public order creation 60/min per IP (`:30`; applied at `backend/routes/api.php:743-744`; keyed by IP only, `RouteServiceProvider.php:57-60`), public promo lookup 10/min per IP (`config/app.php:31`). The `api` throttle is attached through `backend/app/Http/Kernel.php:77`.

**LIM-2 [R] No per-buyer cap, no queue.** Quantity is limited per order only (CAP-1). Searches of `backend/app`, `backend/ee` and `frontend/src` for waiting-room, queue-position, per-buyer, per-email and purchase-limit terms found nothing. The session identifier is a cookie (`CreateOrderActionPublic.php:45,77-79`). Hi.Events does have a *waitlist* (join when sold out, receive time-limited offers; `backend/app/Jobs/Waitlist/ProcessExpiredWaitlistOffersJob.php`, `backend/app/Services/Domain/Waitlist/ProcessWaitlistService.php:243-252`), which is a different feature.

## 10. Not traced (treat as unknown)

Stripe refund-completion webhooks; offline-payment refunds; the waitlist offer lifecycle beyond the lines cited; recurring events and occurrences beyond the capacity maths; seat maps and seat claims (`backend/ee/Seating`); box-office flows beyond the lock and the terminal hold; `ProductPriceService` price/discount calculation; `PromoCodeDomainObject` validity rules; tier "locked behind earlier tier" logic; invoicing and statistics; end-to-end tests under `e2e/`.
