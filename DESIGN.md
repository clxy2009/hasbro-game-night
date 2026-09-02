# Game Night — System Design

## Document purpose

This document describes the Game Night product as it exists today and the architecture that would carry it from launch scale to the stated 12-month target. It deliberately separates shipped behavior from future design so that operational targets are not presented as implemented features.

The system has one non-negotiable correctness rule: a confirmed reservation must never cause an event to exceed capacity. Availability shown to a user may be modestly stale, but every write is decided against authoritative database state.

### Scope and scale

| Dimension               | Launch implementation |                12-month design target |
| ----------------------- | --------------------: | ------------------------------------: |
| Registered players      |           about 2,000 |                         about 200,000 |
| Live events             |              about 50 |                           about 5,000 |
| Traffic                 |      light and steady |            about 50:1 reads to writes |
| Peak shape              |          small bursts |            about 10× event-day spikes |
| Display freshness       |    4–6 second polling | under 10 seconds; SSE where justified |
| Reservation consistency |                strong |  strong within the owning event shard |

### Current and target boundaries

| Concern             | Current implementation                           | Production target                                               |
| ------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Frontend            | React client application                         | Edge-cached application with the same HTTP contracts            |
| Application runtime | Worker-compatible Vinext service                 | Stateless multi-instance service across failure domains         |
| Database            | One D1 SQLite database                           | Start with managed HA storage; shard only after measured limits |
| Identity            | Demo identity picker and server-side role lookup | Google OIDC, server session, CSRF protection, verified roles    |
| Realtime display    | Durable outbox table and bounded polling         | Outbox relay plus SSE, with polling fallback                    |
| Rate limiting       | D1 fixed windows on write paths                  | Gateway, account, IP, and managed Redis limits                  |
| Caching             | No-store event responses                         | Public event-summary cache plus a private viewer overlay        |
| Operations          | CI checks and structured API errors              | SLOs, telemetry, deployment promotion, backups, restore drills  |

---

## 1. Functional requirements

### 1.1 Actors and identity

Game Night has two product roles:

- **Player:** discovers events, reads availability, reserves or cancels one seat, and reviews upcoming events and history.
- **Organizer:** creates events and reads the attendee roster for events that organizer owns.

The current picker returns seeded identities through `GET /api/users`. Each browser request sends `X-User-Id`; the server looks up that ID and role in the database before authorizing a write. The header is an exercise-only identity mechanism, not production authentication.

Production identity should use Google OIDC authorization code flow with PKCE. The callback creates a server-side session. APIs derive `userId`, roles, and organization memberships from that session and never accept identity or role from a client-controlled header.

### 1.2 Player requirements

1. Browse future events ordered by `(starts_at, id)`.
2. Filter by metro, game type, title, game type text, or location text.
3. Open an event and see time, location, organizer, capacity, attendee count, seats remaining, RSVP window, and cancellation cutoff.
4. Reserve one seat when the RSVP window is open and capacity remains.
5. Receive a clear conflict when the last seat was taken concurrently.
6. Cancel the exact active reservation before its cancellation cutoff.
7. See all active reservations in **My events**, including reservations outside the discovery metro.
8. See durable reservation and cancellation history.
9. See explicit loading, empty, reconnecting, action-error, and success states.

### 1.3 Organizer requirements

1. Create a future event with title, game type, metro, start time, location, capacity, RSVP close time, and cancellation cutoff.
2. Default the event metro to the organizer's home metro when the client omits it.
3. View upcoming events owned by the organizer.
4. View the attendee list only for an event owned by that organizer.
5. Never gain player reservation permissions merely by controlling a client request.

Event edit, delete, waitlist, moderation, and notification workflows are intentionally outside the launch feature set.

### 1.4 System invariants

The following invariants must hold at the database boundary:

1. `0 <= attendee_count <= capacity`.
2. A player has at most one active RSVP for an event.
3. A reservation succeeds only while `rsvp_opens_at <= now < rsvp_closes_at` and `now < starts_at`.
4. A cancellation succeeds only while `now < cancellation_closes_at`.
5. A cancellation applies only to the reservation generation named by `If-Match`.
6. A committed idempotency key cannot create the same reservation twice, even after cancellation.
7. Active RSVP state, materialized count, version, history, and outbox change commit or roll back together.
8. Only the owning organizer can read an attendee roster.

---

## 2. Non-functional requirements

### 2.1 Correctness and consistency

- Capacity and duplicate protection are enforced server-side and in the database, not inferred from a browser count.
- The reservation decision is strongly consistent within the database or event shard that owns the event.
- Public counts may be several seconds stale, but the write path always rechecks current state.
- Cross-database projections may be eventually consistent; they must never become reservation authorities.
- Retries must be safe after timeouts, lost responses, process restarts, and duplicate delivery.

### 2.2 Performance

Initial service objectives:

| Operation                | Target                            |
| ------------------------ | --------------------------------- |
| Cached event discovery   | p95 under 300 ms                  |
| Uncached event discovery | p95 under 600 ms                  |
| RSVP/cancel              | p95 under 750 ms outside failover |
| Shared count freshness   | 99% within 10 seconds             |
| Capacity violations      | zero                              |

The event list is the hot read path. The reservation endpoint is lower volume but higher consequence; correctness takes priority over a few additional milliseconds.

### 2.3 Availability and durability

- Target API availability: 99.9% monthly at the 12-month scale.
- A single application instance failure must not interrupt service.
- A cache or message-bus failure must not corrupt or block authoritative reservations.
- A committed reservation should have zero RPO inside the primary HA region when synchronous replication is available.
- Regional disaster targets: RPO no more than five minutes and RTO no more than fifteen minutes, subject to the selected database service.
- Backups are useful only after automated restore verification.

### 2.4 Security and abuse resistance

- Validate every write and every identifier on the server.
- Use parameter binding for database input.
- Bound request bodies; the current JSON limit is 16 KiB.
- Apply role and resource-ownership authorization independently of the UI.
- In production, use secure, HTTP-only, same-site sessions; PKCE; state/nonce checks; CSRF defense; and session rotation.
- Apply layered gateway, account, IP, and resource limits.
- Keep secrets out of source, responses, and logs.
- Separate player, organizer, and future admin permissions.

### 2.5 Maintainability and operability

- Keep HTTP, validation, domain SQL, database initialization, and UI concerns in separate modules.
- Version schema changes and use expand/contract migration patterns.
- Produce typed errors with stable codes.
- Make failures visible through logs, metrics, traces, dashboards, and alerts.
- Keep launch behavior simple; add infrastructure only when load tests or product requirements justify it.

---

## 3. High-level design

### 3.1 Current architecture

```text
Browser
  |
  | HTTPS / HTTP JSON
  v
React application
  |
  | /api/* route handlers
  v
Worker-compatible backend
  |-- identity and role lookup
  |-- Zod and request validation
  |-- write rate limits
  |-- event and reservation services
  v
D1 / SQLite
  |-- current domain tables
  |-- transactional triggers
  |-- immutable RSVP history
  |-- outbox_events change log
  `-- rate-limit windows
```

The frontend never imports database modules. It communicates with the backend only over HTTP. All authoritative decisions occur in route handlers and database statements.

### 3.2 Main request flows

#### Event discovery

```text
Browser
  -> GET /api/events?metroId=...
  -> read outbox cursor
  -> read event snapshot and viewer RSVP overlay
  -> return events + cursor
```

The API captures the cursor before reading the snapshot. If a change commits during the snapshot read, that change remains after the returned cursor and the client will observe it on the next poll.

#### Reserve a seat

```text
Player
  -> POST /api/events/:eventId/rsvp
  -> resolve player identity
  -> validate event ID and idempotency key
  -> enforce user and user/event write limits
  -> check prior completion or active RSVP
  -> conditional INSERT against current capacity and time windows
  -> trigger updates count/version/history/outbox
  -> return 201 + reservation ETag
```

#### Cancel a seat

```text
Player
  -> DELETE /api/events/:eventId/rsvp
  -> require strong If-Match reservation version
  -> conditional DELETE for that exact version and cutoff
  -> trigger decrements count and appends history/outbox
  -> return the latest event state
```

#### Shared freshness

```text
Committed event change
  -> outbox_events row
  -> GET /api/events/changes?since=cursor
  -> client drains bounded pages
  -> client refetches authoritative event snapshot/detail
  -> client commits cursor only after state applies
```

### 3.3 Target production architecture

```text
Clients
  |
  v
CDN + WAF + API Gateway
  |-- TLS and canonical domain
  |-- authentication/session validation
  |-- request IDs and body limits
  |-- account/IP/resource rate limits
  |-- routing and load shedding
  |
  +--------------------+
  |                    |
  v                    v
Discovery service      Reservation service
  |                    |
  v                    v
Edge/cache/read model  Event-owning transactional shard
                            |
                            +-- event + active RSVPs
                            +-- reservation history
                            `-- local outbox
                                      |
                                      v
                                Outbox relay
                                      |
                                      v
                                 Message bus
                         +------------+------------+
                         |            |            |
                         v            v            v
                    User history   Search/read   Notifications
                       store          model
```

This is a target, not the current deployment. The first scaling move should be caching and read-model separation. Database sharding is justified only after load tests show that one writer or one database exceeds safe latency, throughput, or recovery bounds.

---

## 4. API design

### 4.1 Conventions

- JSON requests and responses.
- Stable error envelope:

```json
{
  "error": {
    "code": "EVENT_FULL",
    "message": "This event just filled up. Choose another table.",
    "details": null
  }
}
```

- `400` for malformed identifiers, JSON, or preconditions.
- `401` for missing or unknown identity.
- `403` for role or ownership denial.
- `404` for unknown resources.
- `409` for domain conflicts such as full, closed, or already reserved.
- `412` for a stale reservation generation.
- `413` for an oversized request.
- `422` for valid JSON that violates event rules.
- `428` when cancellation omits `If-Match`.
- `429` with `Retry-After` for rate limiting.
- `500` returns a generic message and logs the internal error.

Current authenticated calls use `X-User-Id`. The production API keeps the same domain routes but derives identity from a session. Clients must not send role, organizer ownership, attendee count, or event version as authority.

### 4.2 Endpoint surface

| Method   | Route                            | Permission                     | Purpose                             |
| -------- | -------------------------------- | ------------------------------ | ----------------------------------- |
| `GET`    | `/api/users`                     | Public demo only               | Populate identity picker            |
| `GET`    | `/api/metros`                    | Public                         | List supported metros and timezones |
| `GET`    | `/api/events`                    | Public; player for `mine=true` | Discover, filter, or list my events |
| `POST`   | `/api/events`                    | Organizer                      | Create an event                     |
| `GET`    | `/api/events/:eventId`           | Public                         | Read detail and viewer RSVP state   |
| `GET`    | `/api/events/changes`            | Public                         | Read bounded outbox cursor pages    |
| `POST`   | `/api/events/:eventId/rsvp`      | Player                         | Reserve one seat                    |
| `DELETE` | `/api/events/:eventId/rsvp`      | Player                         | Cancel exact reservation generation |
| `GET`    | `/api/events/:eventId/attendees` | Owning organizer               | Read attendee roster                |
| `GET`    | `/api/me/history`                | Player                         | Read durable RSVP history           |

### 4.3 Event discovery contract

`GET /api/events` accepts:

- `search`: trimmed text, maximum 80 characters.
- `gameType`: exact type, maximum 60 characters.
- `organizerId`: maximum 100 characters.
- `metroId`: maximum 64 characters.
- `mine`: `true` or `false`.

Discovery is metro-scoped. `mine=true` intentionally removes the metro filter so a player cannot lose sight of an RSVP made in another city. Results are future events ordered by `starts_at, id` and currently capped at 100.

The response includes `changeCursor`; the browser starts incremental polling from that cursor.

### 4.4 Event creation contract

`POST /api/events` accepts title, game type, metro, start time, location, capacity, RSVP close time, and cancellation cutoff. Dates must be ISO-8601 values with offsets. Capacity must be an integer from 1 to 500. The server rejects past starts, reversed windows, unknown metros, and expired cutoffs.

The current limit is ten create attempts per organizer per hour.

### 4.5 Reservation contract

`POST /api/events/:eventId/rsvp` takes no body. A modern client sends:

```http
Idempotency-Key: <opaque value up to 128 characters>
```

Success returns `201` for the first commit or `200` for an idempotent active replay. The response includes an ETag formed from the reservation request ID. A different supplied key while an active RSVP exists returns `409 ALREADY_RSVPED`.

The current limits are 60 RSVP writes per player per minute and 20 per player/event per minute.

### 4.6 Cancellation contract

`DELETE /api/events/:eventId/rsvp` requires:

```http
If-Match: "<active reservation request ID>"
```

The precondition identifies one reservation generation. It prevents a delayed cancellation from deleting a newer reservation created after a cancel/rebook sequence. Replaying a completed cancellation returns success without decrementing capacity twice.

### 4.7 Change-feed contract

`GET /api/events/changes` accepts an integer `since` cursor and optional metro. It reads at most 201 rows, returns at most 200, and sets `hasMore` when another page exists. Multiple changes for the same event within a page collapse to the latest version.

The change feed communicates invalidation, not full domain state. The client must refetch a snapshot before displaying a new count.

---

## 5. Data models

### 5.1 Entity model

```text
metros 1 ---- * users
   |
   `-------- * events * ---- 1 users (organizer)
                       |
                       +---- * rsvps * ---- 1 users (player)
                       |
                       +---- * rsvp_history
                       |
                       `---- * outbox_events

rate_limits       independent operational state
app_metadata      initialization and upgrade markers
```

### 5.2 Tables

#### `metros`

| Column     | Purpose                              |
| ---------- | ------------------------------------ |
| `id`       | Stable primary key                   |
| `slug`     | Unique route/search identifier       |
| `name`     | Display name                         |
| `timezone` | IANA timezone used for event display |

#### `users`

| Column          | Purpose                          |
| --------------- | -------------------------------- |
| `id`            | Stable user ID                   |
| `name`          | Display name                     |
| `role`          | `player` or `organizer`          |
| `home_metro_id` | Default discovery or event metro |

Production role membership should move to account and organization tables. A person may be a player and an organizer; permissions should be capabilities, not a single mutually exclusive profile field.

#### `events`

| Column                            | Purpose                               |
| --------------------------------- | ------------------------------------- |
| `id`                              | Event primary key                     |
| `organizer_id`                    | Owning organizer                      |
| `metro_id`                        | Discovery and timezone scope          |
| `title`, `game_type`, `location`  | Public details                        |
| `starts_at`                       | UTC ISO start instant                 |
| `capacity`                        | Fixed seat limit, 1–500               |
| `rsvp_opens_at`, `rsvp_closes_at` | Reservation window                    |
| `cancellation_closes_at`          | Cancellation cutoff                   |
| `attendee_count`                  | Transactionally maintained projection |
| `version`                         | Monotonic per-event change version    |
| `created_at`                      | Creation time                         |

#### `rsvps`

This table contains only active reservations.

| Column       | Purpose                                    |
| ------------ | ------------------------------------------ |
| `event_id`   | Event shard and primary-key component      |
| `player_id`  | Player and primary-key component           |
| `request_id` | Idempotency key and reservation generation |
| `created_at` | Reservation time                           |

`PRIMARY KEY (event_id, player_id)` enforces one active seat per player/event.

#### `rsvp_history`

Append-only audit history for `reserved` and `canceled` actions. It preserves the request ID and resulting event version. The active row may disappear; history remains available for retry recognition and user history.

The partial unique index on `(event_id, player_id, request_id)` for reserved actions prevents one committed request from producing two reservation-history rows.

#### `outbox_events`

`outbox_events` is a database table, not a separate broker.

| Column          | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `id`            | Auto-increment cursor inside the database/shard |
| `event_id`      | Changed aggregate                               |
| `event_type`    | `event.created` or `capacity.changed`           |
| `event_version` | Version after the transaction                   |
| `occurred_at`   | Commit-related timestamp                        |

The row is written in the same transaction as the domain change. It is a durable statement that an event changed. The current browser polls it through the changes API. A future relay can publish it to a message bus.

#### `rate_limits`

Fixed-window counters keyed by scope and window start. D1 upsert increments the counter atomically. This is sufficient for launch writes but not the final multi-region abuse-control design.

#### `app_metadata`

Durable markers for runtime schema repair and one-time demo seeding.

### 5.3 Constraints and indexes

Database checks enforce role values, capacity bounds, count bounds, and time-window ordering. Important indexes are:

- events by `(starts_at, id)`;
- events by `(organizer_id, starts_at)`;
- events by `(metro_id, starts_at, id)`;
- active RSVPs by `(player_id, event_id)` in addition to the event-first primary key;
- RSVP history by player/time and event/time;
- outbox rows by `(event_id, id)`; and
- expired rate-limit windows by `expires_at`.

At larger scale, discovery adds stable cursor pagination and full-text search. Index design should follow measured query plans, not estimated cardinality alone.

---

## 6. Detailed design and improvement path

### 6.1 Atomicity boundary

Atomicity means all writes inside one reservation decision succeed together or none are visible. The current atomic unit is one SQLite statement plus its triggers:

```text
conditional RSVP INSERT
  -> increment attendee_count
  -> increment event version
  -> append reserved history
  -> append capacity.changed outbox row
```

SQLite executes trigger effects in the same transaction as the statement. If history or outbox insertion fails, the RSVP and count update roll back.

The invariant is local to one database. A cache, search index, notification service, or user-history projection is not part of that ACID transaction and must not decide whether a seat exists.

### 6.2 First-come-first-served reservation

The production SQL is conceptually:

```sql
INSERT INTO rsvps (event_id, player_id, request_id, created_at)
SELECT :event_id, :player_id, :request_id, current_time
WHERE EXISTS (
  SELECT 1
  FROM events
  WHERE id = :event_id
    AND rsvp_opens_at <= current_time
    AND rsvp_closes_at > current_time
    AND starts_at > current_time
    AND attendee_count < capacity
)
AND NOT EXISTS (
  SELECT 1
  FROM rsvp_history
  WHERE event_id = :event_id
    AND player_id = :player_id
    AND action = 'reserved'
    AND request_id = :request_id
)
ON CONFLICT(event_id, player_id) DO NOTHING
RETURNING ...;
```

Capacity is checked inside the write. With serialized database writers, the winner increments `attendee_count` before the next contender evaluates the predicate. A losing write inserts zero rows and the API maps current state to `EVENT_FULL`, `RSVP_NOT_OPEN`, `RSVP_CLOSED`, or `EVENT_STARTED`.

No application queue is required at launch. A queue could smooth an extreme celebrity-event spike, but it adds user-visible waiting, expiry, fairness, and failure-recovery problems. If introduced later, the queue orders attempts; the database remains the final authority.

### 6.3 Duplicate and retry handling

Three mechanisms cover different failure modes:

1. The active RSVP primary key rejects two active rows for one player/event.
2. `Idempotency-Key` identifies one client operation across network retry.
3. Durable reserved history prevents a completed key from rebooking after cancellation.

The browser retains a generated key until it receives success. If the server commits and the response is lost, the retry finds active state or history and returns the original success without changing count.

### 6.4 Safe cancellation

Cancellation is a conditional delete:

```sql
DELETE FROM rsvps
WHERE event_id = :event_id
  AND player_id = :player_id
  AND request_id = :if_match_version
  AND cancellation_closes_at > current_time
RETURNING ...;
```

The delete trigger decrements count with a zero floor, increments event version, and appends canceled history and outbox. A stale `If-Match` cannot delete a newer rebooking. A repeated completed cancellation is recognized from history and does not decrement twice.

### 6.5 Outbox lifecycle

#### Current lifecycle

```text
domain transaction
  -> write outbox row
  -> commit
  -> changes API reads rows by integer cursor
  -> browser refetches changed event snapshot
  -> browser advances cursor after successful apply
```

This prevents the classic dual-write failure in which a domain commit succeeds but an in-memory notification is lost during a process crash.

The current table has no publish status because clients consume it directly by cursor. Before unbounded production use, define retention and archival. Retention must exceed the maximum supported offline/recovery window or clients must fall back to a full snapshot when their cursor is too old.

#### Future relay lifecycle

```text
event shard local transaction
  -> local outbox row
  -> relay claims a bounded batch with a lease
  -> relay publishes to message bus
  -> relay records progress
  -> consumers update read models
```

Publication is at least once: a relay may publish and crash before recording success. Every consumer therefore needs an inbox/deduplication key such as `(consumer_name, shard_id, outbox_id)`.

Ordering is per event, not global. Consumers store the highest `event_version` applied and ignore older messages. After sharding, a cursor is `(shard_id, outbox_id)` because independent shards do not share one global integer sequence.

### 6.6 Snapshot and cursor correctness

The list endpoint reads the outbox cursor before the event snapshot. The client treats a received cursor as a candidate, not a committed offset. It drains up to ten pages per cycle, merges event versions, applies a fresh list/detail snapshot, verifies that the detail version covers the observed change, and only then stores the new cursor.

If any page or snapshot fails, the old cursor remains. Retrying may repeat work, but it does not skip a committed change.

### 6.7 UI state and role boundaries

Players see Discover, My events, History, RSVP, and cancel. Organizers see My events, Create event, and owner-only attendee rosters. The frontend hides irrelevant controls for clarity; the backend independently enforces every permission.

The UI does not optimistically increment capacity. It displays a saving state, waits for the server, then refetches. A stale list can invite an attempt, but it cannot cause overbooking.

### 6.8 Database initialization and schema rollout

Current local startup can create the schema, repair legacy columns, rebuild triggers, backfill counts/request IDs, seed demo data once, remove expired rate windows, and record a completion marker. Initialization is protected by a per-instance shared promise that resets after failure.

Production should run explicit deployment migrations rather than runtime DDL:

1. Backup and validate restore readiness.
2. Apply backward-compatible additions.
3. Deploy code that can read old and new forms.
4. Backfill in bounded, resumable batches.
5. Validate counts, constraints, and replica lag.
6. Switch writers.
7. Remove old fields only in a later release.

### 6.9 Known current bottlenecks

- Event search uses case-insensitive substring scans.
- List responses combine public event data and viewer-specific RSVP state, reducing shared cacheability.
- Results are capped rather than cursor-paginated.
- One database owns every write.
- The outbox grows without an explicit retention job.
- The large client component should be split as product surface grows.
- Demo identity and database-backed fixed-window limits are not production security controls.

---

## 7. Scalability, high availability, sharding, and recovery

### 7.1 Scale the read path first

The expected workload is read-heavy, so the first bottleneck is event discovery rather than reservations.

Recommended sequence:

1. Add stable `(starts_at, id)` cursor pagination.
2. Split public event summaries from the viewer RSVP overlay.
3. Cache public metro/filter pages at the edge for 5–10 seconds.
4. Use stale-while-revalidate and request coalescing to absorb a 10× burst.
5. Invalidate or version cache entries from outbox events.
6. Add FTS or a search service when substring scanning is measured as expensive.
7. Add a dedicated metro read model or read replicas if cache misses still overload the primary.

Redis and edge caches are performance layers. They never authorize a reservation or own the capacity counter.

### 7.2 Database sharding strategy

Do not shard at 50 live events. Sharding adds routing, rebalancing, backup, schema, and cross-shard query complexity. Trigger it from evidence such as sustained writer saturation, unacceptable p99 write latency, unsafe database size, or recovery time beyond target.

#### Write ownership

The reservation aggregate must be colocated:

```text
event
active RSVPs
event RSVP history
event outbox rows
```

The stable write-shard key is `event_id`. Metro can choose a shard group for locality, and consistent hashing or a shard directory can choose a virtual shard inside that group:

```text
metro group = event.metro_id
virtual shard = hash(event.id)
physical shard = shard_directory[virtual shard]
```

Virtual shards allow operators to move a bounded partition without changing every event ID or remapping the full keyspace.

#### Discovery and history projections

Discovery is naturally partitioned by `metro_id`. User history is naturally partitioned by `user_id`. They should be read models fed from the event shard's outbox:

```text
event write shard --outbox--> metro discovery model
                  `---------> user history model
```

Cross-metro **My events** and user history then read the user projection rather than fan out to every event shard.

#### Shard routing

A shard directory stores `event_id -> virtual_shard -> physical_shard`. Cache the mapping, but keep a version and retry one authoritative lookup after a moved-shard response. Event creation allocates a shard before returning the ID.

#### Rebalancing

1. Mark a virtual shard as moving.
2. Copy a consistent snapshot to the target.
3. Stream changes from source outbox/WAL position.
4. Quiesce or fence writes briefly.
5. Apply the final delta and switch the directory version.
6. Keep source read-only for rollback, then retire it.

Never allow both source and target to accept authoritative writes without consensus or fencing.

### 7.3 Cross-database interaction

Avoid a synchronous distributed transaction across event, history, search, cache, and notification stores. Two-phase commit would couple RSVP latency and availability to every participant and make recovery substantially harder.

Use a local transaction plus outbox:

```text
Event DB transaction:
  reserve seat
  update event count/version
  append event history
  append outbox
  commit

Asynchronous consumers:
  update user history store
  update metro discovery read model
  invalidate cache
  send notification
  update analytics
```

Consumers are idempotent and version-aware. A failed optional consumer retries without rolling back a confirmed seat. If a downstream workflow requires compensation, model it as a saga with explicit states; do not pretend it shares the reservation transaction.

### 7.4 Server scaling and Gateway

Application instances are stateless peers:

```text
Gateway
  |-- API instance A
  |-- API instance B
  |-- API instance C
  `-- API instance D
```

Ordinary API instances do not need leader/follower roles. Any instance can process a request because durable state is external. Autoscaling should consider concurrency, CPU, event-loop delay, request latency, and downstream saturation; database saturation must stop scaling from becoming a connection storm.

The Gateway owns:

- TLS and canonical-domain redirects;
- WAF, bot rules, request-size limits, and malformed-request rejection;
- session validation or delegation to the identity service;
- account, IP, route, and event-level rate limits;
- request IDs, deadlines, retry policy, and load shedding;
- routing to player, organizer, reservation, and future admin APIs; and
- stable event-shard routing metadata.

Do not automatically retry non-idempotent writes at the Gateway. RSVP POST is retryable only when the same idempotency key is preserved. Cancellation is retryable with the same `If-Match` value.

### 7.5 Leader, follower, and background work

API instances remain peers. Background work uses a durable queue or leased jobs:

- outbox relay;
- expired-rate-window cleanup;
- retention and archival;
- notification delivery;
- reconciliation; and
- backfills.

A worker claims a job with an expiry. If it dies, another worker can claim the expired lease. A fixed process leader is reserved for systems that truly require one, such as database primary election, and should be managed by the storage/control plane rather than application code.

### 7.6 Database high availability

The target topology is one fenced writer per shard plus replicas:

```text
Primary writer
  |-- synchronous standby in another availability zone
  |-- asynchronous read replica
  `-- cross-region disaster replica or continuous backup
```

Reservation writes and immediate post-write reads go to the primary. Discovery may use replicas only when bounded staleness is acceptable. Failover must fence the old primary before promoting a new writer; two writable primaries could both allocate the last seat.

Required controls:

- health-based failover with quorum/fencing;
- replication-lag monitoring;
- point-in-time recovery;
- encrypted automated backups;
- regular restore drills;
- schema compatibility across primary and replicas; and
- capacity to run on one failure domain during maintenance.

### 7.7 Cache and distributed rate limits

Public cache key dimensions include metro, search/filter hash, page cursor, locale, and schema version. Viewer RSVP state stays in a small private overlay or is merged client-side.

Managed Redis can provide:

- distributed rate-limit counters;
- short-lived session metadata where appropriate;
- cache locks/request coalescing; and
- hot public read entries.

Redis failure behavior is route-specific. Discovery should fall back to the database with load shedding. Security-sensitive limits should fail closed or use a conservative local fallback. Reservation correctness remains available without Redis.

### 7.8 WAL, LSM, application logs, and domain events

- **WAL:** a database durability and replication mechanism; useful for crash recovery and change capture. It is not an application audit API.
- **LSM tree:** an engine structure optimized for high write throughput. It may suit large append-heavy history or event stores, but it does not replace relational constraints needed by the reservation aggregate.
- **Application logs:** diagnostic evidence with retention and access controls. They are not a source of truth and must not contain secrets.
- **Outbox/domain events:** durable business-change records written with the transaction and suitable for downstream integration.

Choose storage engines per workload. Keep the capacity aggregate in a transactional engine even if search, history, analytics, or message retention use different structures.

### 7.9 Failure scenarios

| Failure                                    | Required behavior                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Two players race for the final seat        | One commit; all others receive conflict                                |
| Duplicate RSVP click                       | One active row and one count increment                                 |
| Response lost after commit                 | Same-key retry returns committed success                               |
| Old cancellation arrives after rebook      | `412 RSVP_CHANGED`; newer seat remains                                 |
| Application instance dies before DB commit | Transaction rolls back; retry is safe                                  |
| Application instance dies after DB commit  | Durable RSVP/outbox remain; retry reconstructs result                  |
| Cache is stale or unavailable              | Write checks primary; reads degrade or bypass cache                    |
| Message bus is unavailable                 | Local outbox accumulates; reservations continue within storage limits  |
| Outbox message is duplicated               | Consumer inbox/version check makes processing idempotent               |
| Outbox messages arrive out of order        | Ignore event versions below the highest applied version                |
| Read replica lags                          | Do not use it for write decisions or immediate post-write confirmation |
| Database primary fails                     | Fence old primary, promote standby, retry only idempotent operations   |
| Hot event saturates a shard                | Per-event limits, load shedding, optional queue, and shard isolation   |
| Region fails                               | Route to recovery region after database recovery/promotion             |
| Migration stops midway                     | Resume idempotent expand/backfill steps; old code remains compatible   |
| Client cursor is older than retention      | Return a reset signal and require a full snapshot                      |

### 7.10 CI/CD and recovery

Deployment stages:

1. Lockfile install and production dependency audit.
2. Format, type, lint, unit, concurrency, migration, and build checks.
3. Deploy to an isolated environment and run smoke/contract tests.
4. Apply backward-compatible schema changes.
5. Canary a small traffic percentage while watching errors and latency.
6. Promote gradually; automatically stop on SLO regression.
7. Roll back application code independently of destructive schema changes.

Backups, restore scripts, shard-directory recovery, outbox replay, and failover are exercised on a schedule. A runbook records owners, commands, validation queries, and the conditions for fail-forward versus rollback.

---

## 8. Observability

### 8.1 Current state

The current service has stable API error codes, generic internal-error responses, CI checks, and explicit browser reconnecting/error states. It does not yet have a production telemetry backend, SLO dashboards, or paging.

### 8.2 Structured logs

One JSON request-completion log should include:

- timestamp, environment, release, region, instance, and request ID;
- route template, method, status, duration, and response bytes;
- authenticated actor ID hash and role, never credentials;
- event ID and shard ID where relevant;
- error code and retry classification;
- database duration, rows affected, and retry count;
- cache status; and
- outbox cursor/version for committed writes.

Do not log session tokens, OIDC codes, full request bodies, or sensitive attendee data.

### 8.3 Metrics

#### Product and correctness

- RSVP attempts, commits, idempotent replays, full conflicts, and cancels.
- Active RSVPs versus `events.attendee_count` reconciliation difference.
- Stale-precondition conflicts and duplicate-consumer suppressions.
- Event creation and roster-access denials.

#### Service

- Request rate, errors, duration, and saturation by route/status/region.
- Instance concurrency, CPU, memory, and event-loop delay.
- Gateway rejections and rate-limit decisions.

#### Database

- Write latency, lock wait, busy/serialization retries, and connection use.
- Query latency and rows scanned by normalized query name.
- Replica lag, failover state, storage growth, backup age, and restore result.
- Hot shards and per-event contention.

#### Outbox and messaging

- Oldest unpublished outbox age.
- Rows pending and publish rate per shard.
- Consumer lag, duplicate rate, dead-letter count, and version gaps.
- SSE connections, delivery delay, reconnects, and polling fallbacks.

### 8.4 Tracing

Trace Gateway, application, database, outbox relay, broker, and consumer work with propagated request/trace IDs. A reservation span records the conditional write outcome and event version without recording private payloads.

### 8.5 SLOs and alerts

Initial alerts:

- capacity reconciliation difference greater than zero: immediate page;
- sustained RSVP 5xx or p99 latency breach: page;
- database primary/replication or backup failure: page;
- oldest unpublished outbox age above 60 seconds: urgent alert;
- count freshness above 10 seconds: alert;
- elevated discovery latency/cache miss rate: ticket or alert by severity;
- shard storage or connection saturation above safe headroom: capacity alert.

Every alert links to a runbook and a dashboard that distinguishes application, database, cache, and messaging failure.

---

## 9. Testability and verification

### 9.1 Current automated coverage

The repository currently runs 32 tests covering:

- 24 independent WAL-mode database writers competing for the final seat;
- deterministic multi-contender capacity invariants;
- duplicate RSVP and same-key retry behavior;
- replay after cancellation without rebooking;
- safe cancel/rebook generation handling;
- RSVP and cancellation cutoff boundaries;
- event-start rejection;
- request-body streaming limits and malformed JSON;
- event-filter and local-time helpers;
- cursor pagination, failure rollback, and snapshot/version rules;
- one-time demo seed behavior;
- runtime upgrade of a legacy schema; and
- checked-in migration preservation of rows, foreign keys, triggers, and old writer compatibility.

### 9.2 Required production test pyramid

#### Unit tests

- validation boundaries and typed error mapping;
- cache-key and shard-routing functions;
- idempotency and precondition parsing;
- change-page and backoff behavior;
- consumer version and deduplication rules.

#### Database integration tests

- exact production reservation and cancellation SQL;
- trigger all-or-nothing rollback under injected failures;
- count/history/outbox reconciliation;
- migration from every supported release;
- outbox retention and cursor-reset behavior.

#### API contract tests

- every role and ownership boundary;
- stable error envelopes and headers;
- idempotency after simulated response loss;
- body and identifier limits;
- old/new client compatibility during rollout.

#### Browser tests

- player discovery, detail, RSVP, cancel, My events, and history;
- organizer creation and owner-only roster;
- loading, empty, offline, error, and retry states;
- two browser sessions observing one capacity change;
- mobile navigation, keyboard access, screen-reader names, and focus restoration;
- timezone and DST boundaries.

#### Load and resilience tests

- 50:1 read/write mix with a 10× event-day burst;
- one hot event versus evenly distributed events;
- cache cold start and request coalescing;
- database failover during idempotent writes;
- Redis and broker outage;
- outbox backlog recovery and duplicate delivery;
- shard movement while reads and writes continue;
- regional recovery against stated RPO/RTO.

### 9.3 Release gates

Current CI runs:

```text
npm ci
npm audit --omit=dev
npm run format:check
npm run typecheck
npm run lint
npm test
npm run db:check
npm run build
npm run verify:marker
```

Production promotion additionally requires migration dry-run, smoke tests, security checks, signed artifacts, canary health, and rollback readiness.

### 9.4 Reconciliation and audit tests

Run periodic invariant queries:

```sql
SELECT e.id
FROM events e
WHERE e.attendee_count != (
  SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id
)
OR e.attendee_count < 0
OR e.attendee_count > e.capacity;
```

The expected result is always empty. A non-empty result is a correctness incident, not a dashboard curiosity.

---

## Decision summary

1. Build launch traffic on one transactional database and a stateless HTTP service.
2. Keep first-come-first-served correctness in one conditional database write.
3. Use a primary key, idempotency history, and reservation ETag for duplicate and retry safety.
4. Store count, version, history, and outbox in the same transaction.
5. Treat outbox as a durable database change log; use it for polling now and reliable publication later.
6. Scale the 50:1 read path with pagination, edge caching, request coalescing, and read models before sharding.
7. If sharding becomes necessary, assign one authoritative event shard and colocate the reservation aggregate.
8. Build cross-database projections through at-least-once outbox delivery, idempotent consumers, and event versions rather than distributed transactions.
9. Keep application instances stateless peers; put election/fencing in the database control plane and leases in background work.
10. Put TLS, sessions, WAF, layered limits, request IDs, routing, and load shedding at the Gateway.
11. Keep Redis, replicas, search, and user-history stores outside the capacity authority.
12. Prove availability with failover, restore, replay, and reconciliation exercises—not architecture diagrams alone.
