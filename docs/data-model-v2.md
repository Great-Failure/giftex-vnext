# GiftEx v2 Data Model — Exchange-Centric Architecture

> **Status:** Design (Phase 1). Closes acceptance criteria for [issue #2](https://github.com/Great-Failure/giftex-vnext/issues/2).
> **Source of truth:** `api/src/shared/v2/types.ts`; frontend mirror at `src/lib/v2/types.ts`.
> **ERD:** [`docs/data-model-v2-erd.md`](./data-model-v2-erd.md).

This document defines the Phase 1 data model that replaces the single embedded `Game` document with six distinct entities: **Exchange**, **Invite**, **Participant**, **WishlistItem**, **Match**, and **NotificationEvent**. v1 endpoints and the existing `games` container remain in place; v2 functions and the new `exchanges` container land in [#4](https://github.com/Great-Failure/giftex-vnext/issues/4) (lifecycle), [#5](https://github.com/Great-Failure/giftex-vnext/issues/5) (invites), [#6](https://github.com/Great-Failure/giftex-vnext/issues/6) (matching), and [#12](https://github.com/Great-Failure/giftex-vnext/issues/12) (notifications).

---

## Why this shape

The v1 `Game` document inlines participants, assignments, and reassignment requests. Phase 1 needs:

- A **status state machine** on the exchange itself (Draft → Published → Matching → Matched → Completed) with server-enforced transitions
- **Per-invite tokens** distinct from accepted participants, with RSVP state (Sent / Accepted / Declined / Expired)
- **Multi-item wishlists** per participant, frozen after matching
- **First-class match records** (so we can audit, reveal, and later support reassignment cleanly)
- **Idempotent lifecycle email tracking** so reminders and reveals are sent exactly once per (type, recipient)

A flat single-document model can't represent these cleanly. Splitting into six entities, all partitioned by `exchangeId`, gives each concern its own lifecycle while keeping every read for a single exchange cheap.

---

## Cosmos DB layout

### Container

| Property | Value |
| --- | --- |
| Container name | `exchanges` |
| Partition key path | `/exchangeId` |
| Discriminator field | `entityType` |
| Throughput | Serverless (matches existing tier strategy) |

### Why one container, partitioned by `exchangeId`

- **All data for one exchange lives in one partition.** The organizer panel, RSVP page, wishlist UI, and match reveal each load a single exchange's documents — single-partition queries are the cheapest read pattern Cosmos offers.
- **Entity-type discriminator** (`entityType` field) lets us narrow with `WHERE c.entityType = 'invite'` while keeping co-location.
- **For Exchange documents themselves**, `id === exchangeId` so they live in their own partition along with all their children.
- The alternative — one container per entity — multiplies cross-container query cost for what is fundamentally an aggregate root, with no benefit since no v2 entity needs to be queried across exchanges in the hot path.

### Recommended indexing

The default indexing policy is fine for Phase 1. Two composite indexes will pay for themselves:

| Composite | Used by |
| --- | --- |
| `(exchangeId ASC, entityType ASC)` | Every per-exchange entity fetch (organizer panel, RSVP, wishlist load) |
| `(entityType ASC, status ASC)` | Cross-exchange admin / cleanup queries (e.g., "find expired invites", "find draft exchanges older than N days") |

Path-level recommendations:

- Exclude `description`, `generalNotes`, and `notes` from indexing — large free-text fields rarely filtered on, but expensive to keep indexed.
- Keep `code`, `organizerToken`, and `inviteToken` indexed (frequent point lookups by these values).

### Uniqueness

Cosmos cannot enforce composite uniqueness across partitions, so the following are enforced application-side via a pre-insert lookup:

| Field | Scope | Lookup strategy |
| --- | --- | --- |
| `Exchange.code` | Container-global | Query `WHERE c.entityType='exchange' AND c.code=@code` before insert |
| `Invite.inviteToken` | Container-global | Generate from `crypto.randomUUID()` (collision probability negligible) |
| `Exchange.organizerToken` | Container-global | Same as inviteToken |
| `(Invite.exchangeId, Invite.email)` | Per-exchange | Query existing invites in the partition; one invite per email per exchange |

---

## Entities

Every entity extends the `CosmosDocument` base shape:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Unique within the container. `crypto.randomUUID()`. |
| `exchangeId` | `string` | Partition key. For Exchange docs, equals `id`. |
| `entityType` | `EntityType` | Discriminator literal. |
| `createdAt` | `string` | ISO 8601 timestamp. |
| `updatedAt` | `string` | ISO 8601 timestamp; bumped on every replace. |

### Exchange — root aggregate

| Field | Type | Notes |
| --- | --- | --- |
| `entityType` | `'exchange'` | Discriminator. |
| `code` | `string` | 6-digit human-shareable code. Container-global unique. |
| `exchangeType` | `'custom'` | Phase 1 has one type (ADR-001). Union-ready for Phase 2+. |
| `status` | `ExchangeStatus` | See state machine below. |
| `name` | `string` | Required. |
| `description` | `string?` | Optional long-form. |
| `budget` | `ExchangeBudget?` | `{ currency, amountMin?, amountMax? }`. |
| `exchangeDate` | `string` | YYYY-MM-DD; today-or-future at create time (carry forward v1 validation). |
| `exchangeTime` | `string?` | HH:mm. |
| `location` | `string?` | |
| `generalNotes` | `string?` | |
| `rsvpDeadline` | `string?` | ISO 8601. |
| `wishlistDeadline` | `string?` | ISO 8601. |
| `organizerToken` | `string` | **ADR-001:** the only credential for organizer access. Exchange-scoped magic link. |
| `organizerEmail` | `string?` | Used for organizer lifecycle emails (resends, match-ready alerts). |
| `organizerLanguage` | `Language?` | Email language preference. |
| `publishedAt` | `string?` | Set on Draft → Published. |
| `matchingStartedAt` | `string?` | Set on Published → Matching. |
| `matchedAt` | `string?` | Set on Matching → Matched. |
| `completedAt` | `string?` | Set on Matched → Completed. |
| `cancelledAt` | `string?` | Set on Draft|Published → Cancelled. |

### Invite

| Field | Type | Notes |
| --- | --- | --- |
| `entityType` | `'invite'` | Discriminator. |
| `inviteToken` | `string` | **ADR-001:** per-invite secret; scoped to one exchange. |
| `email` | `string` | Required at create. |
| `suggestedName` | `string?` | Pre-fill on RSVP form; participant can override. |
| `preferredLanguage` | `Language?` | Email hint. |
| `status` | `InviteStatus` | See state machine below. |
| `sentAt` | `string` | First send. |
| `lastResentAt` | `string?` | Most recent resend. |
| `respondedAt` | `string?` | Accepted/declined timestamp. |
| `expiresAt` | `string?` | When the invite is considered expired. |
| `participantId` | `string?` | Set when status becomes `accepted`. |

### Participant

| Field | Type | Notes |
| --- | --- | --- |
| `entityType` | `'participant'` | Discriminator. |
| `inviteId` | `string` | The Invite this participant accepted. |
| `displayName` | `string` | **ADR-001:** the only required participant profile field. |
| `email` | `string` | Carried from Invite. |
| `preferredLanguage` | `Language?` | |
| `profile` | `ParticipantProfile?` | All sub-fields optional (avatarUrl, pronouns, interests[], sizes, allergens[]). |
| `hasConfirmedAssignment` | `boolean?` | Set after Match reveal acknowledgement. |
| `joinedAt` | `string` | ISO 8601. |

**No address/shipping fields exist anywhere in the schema.** Per ADR-001, address collection is deferred to Phase 3 privacy escrow.

### WishlistItem

| Field | Type | Notes |
| --- | --- | --- |
| `entityType` | `'wishlistItem'` | Discriminator. |
| `participantId` | `string` | Owning participant. |
| `title` | `string` | Required. |
| `url` | `string?` | Optional product/inspiration URL. |
| `notes` | `string?` | Optional free-text. |
| `priority` | `WishlistPriority` | `'high' \| 'medium' \| 'low'`. |

Edits blocked at the application layer once `Exchange.status === 'matched'`.

### Match

| Field | Type | Notes |
| --- | --- | --- |
| `entityType` | `'match'` | Discriminator. |
| `giverParticipantId` | `string` | |
| `receiverParticipantId` | `string` | |
| `revealStatus` | `MatchRevealStatus` | `'pending' \| 'revealed'`. |
| `revealedAt` | `string?` | When the giver saw their match. |

Cycle integrity (each participant appears once as giver and once as receiver) is enforced by the matching engine in [#6](https://github.com/Great-Failure/giftex-vnext/issues/6), not by the type system.

### NotificationEvent

| Field | Type | Notes |
| --- | --- | --- |
| `entityType` | `'notificationEvent'` | Discriminator. |
| `type` | `NotificationType` | `inviteSent \| rsvpAccepted \| wishlistReminder \| matchReveal \| giftByReminder`. |
| `recipientKind` | `NotificationRecipientKind` | `'participant' \| 'invite' \| 'organizer'`. |
| `recipientRefId` | `string` | Participant.id, Invite.id, or Exchange.id depending on kind. |
| `recipientEmail` | `string` | Snapshot for audit. |
| `status` | `NotificationStatus` | `queued \| sent \| failed \| bounced`. |
| `sentAt` | `string` | ISO 8601. |
| `providerMessageId` | `string?` | From ACS. |
| `failureReason` | `string?` | When `failed`/`bounced`. |
| `idempotencyKey` | `string` | Proposed shape: `${exchangeId}:${type}:${recipientRefId}`; finalized in [#12](https://github.com/Great-Failure/giftex-vnext/issues/12). |

---

## Status state machines

### ExchangeStatus

```
            ┌──────────────────────┐
            │                      ▼
draft ──▶ published ──▶ matching ──▶ matched ──▶ completed
   │           │
   └────┬──────┘
        ▼
    cancelled (terminal)
```

| From | Allowed → | Triggered by |
| --- | --- | --- |
| `draft` | `published`, `cancelled` | Organizer publishes / cancels |
| `published` | `matching`, `cancelled` | Organizer triggers match / cancels |
| `matching` | `matched` | Matching engine completes successfully |
| `matched` | `completed` | Exchange date passes (or organizer marks done) |
| `completed` | *(terminal)* | — |
| `cancelled` | *(terminal)* | — |

Notes:
- A failed matching attempt does **not** transition; it stays in `matching` until the engine succeeds.
- Re-running matching from `matched` is out of scope for Phase 1 (carries forward as Phase 2 reassignment work).

### InviteStatus

```
sent ──▶ accepted
  │
  ├──▶ declined
  │
  └──▶ expired (passive, time-based)
```

| From | Allowed → | Triggered by |
| --- | --- | --- |
| `sent` | `accepted`, `declined`, `expired` | RSVP submission / TTL elapsed |
| `accepted` | *(terminal)* | — |
| `declined` | *(terminal)* | — |
| `expired` | *(terminal)* | — |

Resends do not change `status`; they update `lastResentAt`. New invites cannot be created once `Exchange.status` reaches `matching` (enforced in [#5](https://github.com/Great-Failure/giftex-vnext/issues/5)).

### MatchRevealStatus

```
pending ──▶ revealed
```

| From | Allowed → | Triggered by |
| --- | --- | --- |
| `pending` | `revealed` | Giver opens their reveal link (or MatchReveal email delivers) |
| `revealed` | *(terminal)* | — |

### NotificationStatus

```
queued ──▶ sent
   │
   ├──▶ failed
   │
   └──▶ bounced
```

| From | Allowed → | Triggered by |
| --- | --- | --- |
| `queued` | `sent`, `failed`, `bounced` | ACS delivery callback |
| `sent` | `bounced` | Async bounce webhook (carry forward late) |
| `failed` | *(terminal)* | — |
| `bounced` | *(terminal)* | — |

---

## Validation rules

| Rule | Source | Enforced where |
| --- | --- | --- |
| `Exchange.exchangeDate` is today or future | Carry forward from v1 | API layer in [#4](https://github.com/Great-Failure/giftex-vnext/issues/4) |
| `Exchange.code` is exactly 6 digits | Carry forward from v1 | Application-side generator |
| `Exchange.code` is container-globally unique | New | Pre-insert lookup in [#4](https://github.com/Great-Failure/giftex-vnext/issues/4) |
| Min 3, max 50 accepted Participants before matching | **ADR-001** | Matching engine in [#6](https://github.com/Great-Failure/giftex-vnext/issues/6); also enforced at invite-create time in [#5](https://github.com/Great-Failure/giftex-vnext/issues/5) |
| One Invite per (exchangeId, email) | New | Pre-insert lookup in [#5](https://github.com/Great-Failure/giftex-vnext/issues/5) |
| WishlistItem edits blocked when `Exchange.status === 'matched'` | New | API guard in wishlist endpoints |
| `Participant.displayName` required, non-empty | **ADR-001** | RSVP accept handler in [#5](https://github.com/Great-Failure/giftex-vnext/issues/5) |
| No address/shipping fields stored | **ADR-001** | Type system + code review |
| Notification dedupe via `idempotencyKey` | New | Email service in [#12](https://github.com/Great-Failure/giftex-vnext/issues/12) |

---

## ADR-001 compliance map

Every ADR-001 acceptance criterion from [issue #2](https://github.com/Great-Failure/giftex-vnext/issues/2) is mapped here to its schema location:

| ADR-001 constraint | Schema location |
| --- | --- |
| Organizer access = exchange-scoped magic-link token; no full login/SSO/password | `Exchange.organizerToken` — the only organizer credential field |
| Invite/participant access = per-invite tokens scoped to the exchange | `Invite.inviteToken`; no global participant identity table |
| Participant schema requires display name only | `Participant.displayName` (required); all profile fields nested in optional `Participant.profile` |
| Avatar, interests, sizes, pronouns, allergens are optional structured fields | `ParticipantProfile` (all sub-fields optional) |
| Address/shipping fields are excluded from Phase 1 schemas | **No address/shipping fields exist anywhere** — deliberately absent from Exchange, Invite, Participant, ParticipantProfile |
| Single Phase 1 exchange type: `custom` | `ExchangeType = 'custom'` literal (union-ready for Phase 2+) |
| Validation: min 3, max 50 participants | `PARTICIPANT_BOUNDS = { min: 3, max: 50 }` exported constant; enforced in [#5](https://github.com/Great-Failure/giftex-vnext/issues/5) and [#6](https://github.com/Great-Failure/giftex-vnext/issues/6) |

---

## v1 → v2 differences (for downstream issues)

| Concept | v1 (`games`) | v2 (`exchanges`) |
| --- | --- | --- |
| Aggregate root | `Game` single document with embedded arrays | Six entity types in one container |
| Partition key | `/id` | `/exchangeId` |
| Status | None (implicit via field presence) | Explicit `Exchange.status` enum + state machine |
| Participants | Embedded `participants[]` array on Game | Separate `Participant` documents |
| Invitations | Single `invitationToken` on Game | One `Invite` document per recipient with `inviteToken` and RSVP state |
| Wishlist | Single string fields per participant (`desiredGift`, `wish`) | Multi-item `WishlistItem` documents per participant with `priority` |
| Assignments | Embedded `assignments[]` array (in-memory shuffle) | Persisted `Match` documents with reveal status |
| Email dedup | None | `NotificationEvent` records with `idempotencyKey` |
| `createdAt` type | `number` (epoch ms) | `string` (ISO 8601) — applies to all timestamps |
| Date field | `date: string` (YYYY-MM-DD) | `exchangeDate: string` (YYYY-MM-DD) — semantic rename |
| Currency/amount | `amount: string`, `currency: string` | `budget: { currency, amountMin?, amountMax? }` |

The v1 container and endpoints stay in place; v2 will be a parallel surface, with cutover and migration planned in a follow-up issue (out of scope for #2).

---

## Open considerations (review during downstream work)

These are intentionally left out of the schema definition and flagged for the relevant issue:

| Item | Where it surfaces |
| --- | --- |
| `WishlistPriority`: string union vs numeric tiers — current choice is `'high' \| 'medium' \| 'low'`, may switch to numeric if sorting needs are heavy | [#10](https://github.com/Great-Failure/giftex-vnext/issues/10) |
| `Exchange.allowReassignment`: carry forward from v1 or drop? Current design **drops it** (Phase 1 PRD doesn't require it; Phase 2 candidate) | [#6](https://github.com/Great-Failure/giftex-vnext/issues/6) |
| `NotificationEvent.idempotencyKey` exact format — proposed `${exchangeId}:${type}:${recipientRefId}` | [#12](https://github.com/Great-Failure/giftex-vnext/issues/12) |
| Whether `Match` reveal happens per-giver-open or all-at-once (push) — affects when `revealedAt` is set | [#6](https://github.com/Great-Failure/giftex-vnext/issues/6) |
| Invite TTL default and renewal policy | [#5](https://github.com/Great-Failure/giftex-vnext/issues/5) |
| Soft-delete vs hard-delete for `cancelled` exchanges | Migration follow-up |
