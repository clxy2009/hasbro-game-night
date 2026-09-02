# Game Night

A small, complete community event board for tabletop players and organizers. Players can find an upcoming game, see live availability, RSVP or cancel, and review their saved events. Organizers can publish events and see the roster for events they own.

## Run it

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A fresh database initializes itself on the first request with future events across Seattle, Portland, and the Bay Area: several open, one near-full, and one full.

The identity picker in the header includes both roles. Start as **Maya Chen** for the player flow, then switch to **Meeple House** or **Tabletop Commons** for the organizer flow. Authentication is intentionally a name picker for this exercise; role and ownership rules are still enforced by the API.

Useful checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:marker
```

For the complete requirements, architecture, API and data contracts, concurrency model, scalability path, observability plan, and recovery/test strategy, see [DESIGN.md](./DESIGN.md).

## What is implemented

| Area                      | Shipped behavior                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product flows             | Mobile-first discovery, text/game filters, event detail, one-tap RSVP/cancel, all-metro My events, RSVP history, organizer event creation, and owner-only attendee rosters.                                                                                                                                                   |
| Frontend/backend boundary | React talks only to HTTP route handlers. Every business write resolves identity/role and validates server-side input; the browser never imports database code.                                                                                                                                                                |
| Capacity and concurrency  | One conditional `INSERT … SELECT` rechecks RSVP windows, event start, and `attendee_count < capacity` at the authoritative database. The RSVP primary key and transactional triggers prevent duplicate active rows and overbooking across concurrent writers.                                                                 |
| Retry semantics           | A supplied RSVP idempotency key is stored on the active row and in immutable history. Same-key retries return the original success, a different key conflicts, keyless legacy clients keep state-based compatibility, and a delayed replay after cancellation never rebooks.                                                  |
| Cancellation              | A strong `If-Match` precondition identifies the exact reservation generation. One conditional delete enforces that version and the cutoff, releases at most one seat, and transactionally appends history/outbox/version changes. Replaying the same cancellation is safe; an old cancellation cannot delete a newer booking. |
| Shared freshness          | Event creation and capacity changes append a transactional outbox record. The writer refetches immediately; other visible clients drain bounded cursor pages every 4–6 seconds and commit a cursor only after its snapshot/detail applies.                                                                                    |
| Geography and policy      | Structured metros and IANA timezones drive discovery and display. Users have a home metro, organizers choose an event metro, My events spans metros, and RSVP/cancellation cutoffs are stored and enforced server-side.                                                                                                       |
| Persistence and rollout   | D1 stores current state, immutable history, outbox rows, and rate-limit windows. Checked-in Drizzle migrations preserve existing RSVP/history/outbox rows, foreign keys, triggers, and the previous event-writer contract; runtime startup can repair an interrupted legacy local backfill.                                   |
| UX failure handling       | Loading, empty, action-error, creation-error, reconnecting, offline, and success states are rendered explicitly. Failed writes refetch authoritative event state instead of leaving optimistic capacity behind.                                                                                                               |
| Abuse controls            | Bounded JSON bodies, typed errors, validated identifiers, player/event write limits, server-side role checks, and organizer ownership checks protect current launch traffic.                                                                                                                                                  |
| Growth design             | The design covers read-heavy event-day spikes, edge caching and request coalescing, cursor pagination/FTS, outbox-to-SSE, Redis/gateway limits, multi-instance behavior, database HA, CI/CD, observability, backups, recovery, and failure injection. These are clearly labeled as targets rather than current claims.        |

## Product decisions

- **Mobile-first player flow.** The browse surface opens directly to searchable, soonest-first events. Availability, RSVP state, time, and place are visible without opening a detail view. Mobile navigation keeps Discover and My events within thumb reach.
- **One interface, role-aware behavior.** Switching to an organizer replaces player navigation with My events and Create event. This keeps the intentionally simple identity model understandable while making the permissions visible.
- **Details in focused dialogs.** A player can inspect and RSVP without losing their filters or scroll position. An organizer gets the attendee list in the same context.
- **No waitlist.** The brief requires first-come-first-served capacity, so a full event is a hard stop. The API returns `409 EVENT_FULL`, including if the last seat disappeared while the player was looking at the event.
- **Times are stored as UTC ISO-8601 values** and event displays use the metro's IANA timezone. Demo seed dates are generated once, relative to the fresh database's first run.
- **Metro is explicit.** Discovery uses one selected metro, while My events intentionally spans every metro so it cannot hide a saved seat. Seeded users have a home metro, and organizers attach a structured metro/timezone to every event.
- **Reservation policy is visible.** Every event has server-enforced RSVP and cancellation cutoffs. The default is event start, while organizers may choose earlier deadlines.
- **Fast shared freshness without a fake realtime claim.** Event creation and every committed RSVP/cancel append an outbox row; RSVP/cancel also update the materialized count, version, and history atomically. The writer refetches immediately, while other visible browsers check the outbox every 4–6 seconds.
- **Simple substring search.** Title, game type, and location are matched case-insensitively. At launch scale, a scan over roughly 50 live events is a good simplicity tradeoff.

## Architecture

- **Frontend:** React 19 client application, TypeScript, Tailwind, and accessible shadcn/Base UI primitives.
- **HTTP boundary:** Next-compatible route handlers under `app/api`. The UI does not import database code or mutate server state directly.
- **Backend:** Cloudflare Worker-compatible Vinext runtime and D1 (SQLite). Zod validates every event creation request. Write endpoints resolve `X-User-Id` to a server-side role; attendee lists also check event ownership.
- **Persistence:** D1 stores metros, users, events, active RSVPs, immutable RSVP history, change-outbox rows, and write-rate windows. Checked-in Drizzle migrations preserve dependent rows and keep the previous event writer compatible during rollout. Local startup creates the current schema or upgrades the original local columns before indexes/triggers, then uses a durable marker to add missing demo records exactly once; it never seeds RSVPs into an event that already existed.
- **Indexes:** upcoming events by `(starts_at, id)`, organizer events by `(organizer_id, starts_at)`, and player RSVPs by `(player_id, event_id)`. The RSVP primary key begins with `event_id`, which also supports event attendee counts.
- **Capacity projection:** insert/delete triggers maintain `events.attendee_count` and `events.version` in the same transaction as the active RSVP row, then append history and outbox records.

### API surface

| Method   | Route                       | Permission                                | Purpose                                 |
| -------- | --------------------------- | ----------------------------------------- | --------------------------------------- |
| `GET`    | `/api/users`                | Public                                    | Identity picker                         |
| `GET`    | `/api/metros`               | Public                                    | Supported discovery metros              |
| `GET`    | `/api/events`               | Public; identity required for `mine=true` | Browse, search, filter, my events       |
| `POST`   | `/api/events`               | Organizer                                 | Create a validated future event         |
| `GET`    | `/api/events/:id`           | Public                                    | Event detail and viewer RSVP state      |
| `GET`    | `/api/events/changes`       | Public                                    | Versioned event/capacity polling cursor |
| `POST`   | `/api/events/:id/rsvp`      | Player                                    | Reserve a seat                          |
| `DELETE` | `/api/events/:id/rsvp`      | Player                                    | Cancel an RSVP                          |
| `GET`    | `/api/events/:id/attendees` | Owning organizer                          | View an event roster                    |
| `GET`    | `/api/me/history`           | Player                                    | Durable RSVP/cancellation history       |

Errors use a consistent shape: `{ "error": { "code", "message", "details?" } }` with meaningful `4xx` status codes.

Cancellation requires `If-Match: "<rsvpVersion>"`, using the version returned with the viewer's active RSVP. A missing precondition returns `428`; a stale generation returns `412` without changing the newer reservation.

## Capacity and retry correctness

The important invariant lives in the database, not in a prior application-level check.

RSVP creation is one `INSERT … SELECT … WHERE` statement. Its predicate checks the opening/closing window, event start, and materialized `attendee_count < capacity`. SQLite serializes writers; the insert trigger increments the count/version in the same transaction, so the next contender reevaluates the new count. The losing statement inserts no row and the API reports the now-full event.

`PRIMARY KEY (event_id, player_id)` enforces one active RSVP per player per event. `ON CONFLICT DO NOTHING` makes concurrent duplicates safe. When a client supplies a request key, only the key stored on the active row is accepted as an idempotent retry; a different supplied key receives `409 ALREADY_RSVPED`. A previous keyless client retains state-based POST compatibility. A committed key is also checked against durable history, so replaying it after cancellation returns the original success without rebooking. The same durable request key is the reservation generation used by conditional cancellation, preventing a delayed delete from removing a later rebooking.

The focused tests execute that exact production SQL against SQLite and cover:

- 24 genuinely parallel database connections plus 40 deterministic contenders for one remaining seat;
- ten retries from the same player;
- same-key retry, distinct-key conflict, and replay of the committed key after cancellation;
- idempotent cancellation, stale-cancel rejection after rebooking, history/outbox/version updates, and transfer of the freed seat;
- RSVP opening/closing and cancellation cutoffs; and
- rejection after an event starts, bounded request bodies, migrations, one-time seed policy, and change-cursor pagination.

## Count freshness

List and detail counts read the trigger-maintained authoritative event counter and are sent with `Cache-Control: no-store`. The list API captures its outbox cursor before reading the snapshot, so a concurrent commit cannot fall into a cursor gap. Other visible browsers drain bounded change pages every 4–6 seconds. The client commits a candidate cursor only after every page and the corresponding snapshot/detail have applied successfully; a transient failure retries from the prior committed cursor. Mine consumes all-metro changes, while the other views remain metro-scoped.

## Path to the 12-month target

The API and tables can grow without changing the product boundary. Before 5,000 live events and roughly 100× list traffic, I would:

1. Paginate with a stable `(starts_at, id)` cursor and cap search results. Replace substring search with SQLite FTS or a search service once product needs justify it.
2. Split broadly cacheable public event summaries from the small viewer RSVP overlay, then cache metro/filter pages at the edge for about 5–10 seconds with request coalescing and stale-while-revalidate.
3. Replace change polling with transactional-outbox publication and multiplexed SSE when sub-second display freshness is worth the operational cost.
4. Add read replicas or a dedicated read model if edge caching is not enough. Capacity decisions never move to Redis; reservation correctness stays in one transactional datastore.
5. Load-test the hot event pattern and size D1/SQLite limits from evidence. If a single writer becomes the bottleneck, partition by event/metro or move reservations to PostgreSQL with the same conditional-insert, version, trigger/outbox, and unique-key contract.

## Before real traffic

- Replace the picker and trusted `X-User-Id` demo header with session-based authentication, CSRF protection, organizer verification, and authorization tests at the edge.
- For the current demo, configure the actual `workers.dev` origin in `SITE_ORIGIN`; metadata is intentionally omitted when it is unset. Move to an owned custom domain before production launch.
- Move bootstrap seeding out of runtime code into explicit environment migrations and development seed tooling.
- Add request IDs, structured logs, traces, database/query metrics, error reporting, SLOs, dashboards, and alerts.
- Move the current write limiter to gateway/account/IP enforcement, add bot controls, and keep reservation correctness independent of throttling.
- Add end-to-end browser tests, timezone/DST cases, accessibility audits, and broader API contract tests.
- Add deployment promotion/rollback, backups, restore drills, migration checks, and dependency/security scanning.
- Define cancellation policy, moderation, edits/deletes, notifications, and data retention with product stakeholders.
- Move distributed rate limiting to the gateway/managed Redis when multiple runtimes need a shared abuse budget; the current D1 fixed-window limiter intentionally protects writes only.
- Split the large client component into event-feed, player, organizer, detail, and creation modules as the UI grows.
- Upgrade the inherited Drizzle development toolchain after verifying generated migrations, removing its development-only audit advisory without changing production behavior.

## Verification

CI installs from the lockfile, checks the production dependency graph, verifies formatting, TypeScript, lint, tests, Drizzle schema consistency, the production build, and a case-insensitive binary scan of tracked and deployable files for the forbidden marker. The concurrency suite uses 24 independent WAL-mode database writers for the final seat. Migration tests preserve existing rows and foreign keys and exercise both post-migration triggers and the previous event writer.
