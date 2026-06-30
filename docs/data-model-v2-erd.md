# GiftEx v2 Entity-Relationship Diagram

> See [`data-model-v2.md`](./data-model-v2.md) for field-level detail, Cosmos partitioning strategy, status state machines, and ADR-001 compliance map.

All six v2 entities live in a single Cosmos DB container named `exchanges`, partitioned by `/exchangeId`. The partition key value for every document is annotated on each entity below.

```mermaid
erDiagram
    EXCHANGE ||--o{ INVITE : "issues"
    EXCHANGE ||--o{ PARTICIPANT : "has accepted"
    EXCHANGE ||--o{ MATCH : "produces"
    EXCHANGE ||--o{ NOTIFICATION_EVENT : "tracks sends for"
    INVITE ||--o| PARTICIPANT : "is accepted by"
    PARTICIPANT ||--o{ WISHLIST_ITEM : "owns"
    PARTICIPANT ||--o| MATCH : "is giver in"
    PARTICIPANT ||--o| MATCH : "is receiver in"

    EXCHANGE {
        string id PK "= exchangeId for this doc"
        string exchangeId "partition key"
        string entityType "= 'exchange'"
        string code "6-digit, container-globally unique"
        string exchangeType "Phase 1: 'custom' only"
        string status "draft|published|matching|matched|completed|cancelled"
        string name
        string organizerTokenHash "SHA-256 of magic-link token"
        string organizerTokenExpiresAt "optional, ISO 8601 token expiry"
        string organizerEmail "optional"
        string exchangeDate "YYYY-MM-DD"
        string createdAt "ISO 8601"
        string updatedAt "ISO 8601"
    }

    INVITE {
        string id PK
        string exchangeId FK "partition key"
        string entityType "= 'invite'"
        string inviteTokenHash "SHA-256 of per-invite, exchange-scoped token"
        string email
        string status "sent|accepted|declined|expired"
        string sentAt "ISO 8601"
        string participantId FK "set when accepted"
    }

    PARTICIPANT {
        string id PK
        string exchangeId FK "partition key"
        string entityType "= 'participant'"
        string inviteId FK
        string displayName "ADR-001: only required profile field"
        string email
        string preferredLanguage "optional"
        object profile "optional: avatar, pronouns, interests, sizes, allergens"
        boolean hasConfirmedAssignment "optional"
        string joinedAt "ISO 8601"
    }

    WISHLIST_ITEM {
        string id PK
        string exchangeId FK "partition key"
        string entityType "= 'wishlistItem'"
        string participantId FK
        string title
        string url "optional"
        string notes "optional"
        string priority "high|medium|low"
    }

    MATCH {
        string id PK
        string exchangeId FK "partition key"
        string entityType "= 'match'"
        string giverParticipantId FK
        string receiverParticipantId FK
        string revealStatus "pending|revealed"
        string revealedAt "optional, ISO 8601"
    }

    NOTIFICATION_EVENT {
        string id PK
        string exchangeId FK "partition key"
        string entityType "= 'notificationEvent'"
        string type "inviteSent|rsvpAccepted|wishlistReminder|matchReveal|giftByReminder"
        string recipientKind "participant|invite|organizer"
        string recipientRefId FK "Participant.id, Invite.id, or Exchange.id"
        string recipientEmail
        string status "queued|sent|failed|bounced"
        string idempotencyKey "container-globally unique per (type, recipient)"
        string sentAt "ISO 8601"
    }
```

## Relationship summary

| From | Cardinality | To | Notes |
| --- | --- | --- | --- |
| Exchange | 1 — 0..N | Invite | One Invite per recipient email per Exchange |
| Exchange | 1 — 0..N | Participant | Only created when an Invite is accepted |
| Exchange | 1 — 0..N | Match | N = participant count after matching |
| Exchange | 1 — 0..N | NotificationEvent | Audit + dedupe record per send |
| Invite | 1 — 0..1 | Participant | An Invite has at most one Participant (set on accept) |
| Participant | 1 — 0..N | WishlistItem | Multi-item wishlist; frozen after `Exchange.status === 'matched'` |
| Participant | 1 — 0..1 | Match (as giver) | Each Participant gives exactly once after matching; 0 before |
| Participant | 1 — 0..1 | Match (as receiver) | Each Participant receives exactly once after matching; 0 before |

## NotificationEvent recipient resolution

`NotificationEvent.recipientRefId` is polymorphic — its referent depends on `recipientKind`:

| `recipientKind` | `recipientRefId` references | When used |
| --- | --- | --- |
| `participant` | `Participant.id` | After RSVP accept (RSVPAccepted, WishlistReminder, MatchReveal, GiftByReminder) |
| `invite` | `Invite.id` | InviteSent — before a Participant exists |
| `organizer` | `Exchange.id` | Organizer-targeted notifications (organizer is identified by `Exchange.organizerTokenHash`, not a separate user record) |

This is enforced at the application layer, not by foreign-key constraints (Cosmos has none).

## Partition-key implication

Because every entity carries `exchangeId` and uses it as the partition key, loading the full state for a single exchange — Exchange + all Invites + all Participants + all Wishlists + all Matches + recent NotificationEvents — is a single-partition query. This is the hot path for the organizer panel and the RSVP / wishlist / match-reveal views.
