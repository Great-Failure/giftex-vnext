/**
 * v2 Data Model — Exchange-Centric Architecture
 *
 * Source of truth for the API. The frontend mirror at `src/lib/v2/types.ts` must
 * be kept in sync manually, matching the v1 convention.
 *
 * See `docs/data-model-v2.md` for the design rationale, Cosmos partitioning
 * strategy, status transition tables, validation rules, and ADR-001 compliance
 * map. The entity-relationship diagram lives at `docs/data-model-v2-erd.md`.
 *
 * Scope: this file defines the shapes only. v1 endpoints and the existing
 * `games` container remain untouched. v2 functions and the new `exchanges`
 * container land in #4 (Exchange lifecycle), #5 (Invite/RSVP), #6 (Matching
 * engine), and #12 (NotificationEvent).
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** ISO 4217 currency code (e.g., "USD", "EUR"). Phase 1 reuses the v1 currency list. */
export type CurrencyCode = string

/**
 * Languages supported for email notifications.
 * Kept identical to v1 `src/lib/types.ts` `Language`.
 */
export type Language =
  | 'en'
  | 'es'
  | 'pt'
  | 'fr'
  | 'it'
  | 'ja'
  | 'zh'
  | 'de'
  | 'nl'

/**
 * Entity-type discriminator. Every document in the `exchanges` container
 * carries this field; queries narrow by it to the right entity shape.
 */
export type EntityType =
  | 'exchange'
  | 'invite'
  | 'participant'
  | 'wishlistItem'
  | 'match'
  | 'notificationEvent'

/**
 * Shape common to every Cosmos document in the `exchanges` container.
 *
 * The container is partitioned by `/exchangeId`. For an Exchange document
 * itself, `exchangeId === id`. For all child entities, `exchangeId` references
 * the parent Exchange.id and co-locates the document in the same partition.
 */
export interface CosmosDocument {
  /** Document id, unique within the container. */
  id: string
  /** Partition key. References the owning Exchange.id (or equals it for Exchange docs). */
  exchangeId: string
  /** Entity-type discriminator. */
  entityType: EntityType
  /** ISO 8601 timestamp string. */
  createdAt: string
  /** ISO 8601 timestamp string; updated on every replace. */
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Exchange (root aggregate)
// ---------------------------------------------------------------------------

/**
 * Exchange lifecycle states. See `docs/data-model-v2.md` for the transition table.
 *
 *   draft → published → matching → matched → completed
 *   draft|published → cancelled (terminal)
 */
export type ExchangeStatus =
  | 'draft'
  | 'published'
  | 'matching'
  | 'matched'
  | 'completed'
  | 'cancelled'

/**
 * Phase 1 supports a single exchange type per ADR-001.
 * Modeled as a union so Phase 2+ template types can be added without a breaking change.
 */
export type ExchangeType = 'custom'

/** Budget guidance shown to participants. Either bound is optional. */
export interface ExchangeBudget {
  currency: CurrencyCode
  /** Numeric string (e.g., "25.00"). Optional when only `amountMax` is set. */
  amountMin?: string
  /** Numeric string (e.g., "50.00"). Optional when only `amountMin` is set. */
  amountMax?: string
}

/**
 * Root aggregate. The `id` of this document IS the `exchangeId` used as the
 * partition key for all related Invite / Participant / WishlistItem / Match /
 * NotificationEvent documents.
 */
export interface Exchange extends CosmosDocument {
  entityType: 'exchange'

  /**
   * Short, human-shareable 6-digit code (same shape as the v1 game code).
   * Globally unique within the container; uniqueness is enforced application-side
   * via a pre-insert lookup.
   */
  code: string

  exchangeType: ExchangeType

  status: ExchangeStatus

  name: string
  description?: string

  budget?: ExchangeBudget

  /** Event date as YYYY-MM-DD (local to organizer). */
  exchangeDate: string
  /** Optional event time as HH:mm. */
  exchangeTime?: string
  location?: string
  generalNotes?: string

  /** ISO 8601 timestamps for organizer-set deadlines. */
  rsvpDeadline?: string
  wishlistDeadline?: string

  /**
   * ADR-001: organizer access is gated by this exchange-scoped magic-link token.
   * No SSO/login/password account model in Phase 1.
   */
  organizerToken: string
  organizerEmail?: string
  organizerLanguage?: Language

  // Lifecycle timestamps. Set when the corresponding transition occurs.
  publishedAt?: string
  matchingStartedAt?: string
  matchedAt?: string
  completedAt?: string
  cancelledAt?: string
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

/**
 * Invite RSVP states. See `docs/data-model-v2.md` for the transition table.
 *
 *   sent → accepted | declined
 *   sent → expired (passive, time-based)
 */
export type InviteStatus = 'sent' | 'accepted' | 'declined' | 'expired'

/**
 * One Invite per recipient email per Exchange. ADR-001: invite tokens are
 * per-invite and scoped to a single exchange; there is no cross-exchange
 * participant identity.
 */
export interface Invite extends CosmosDocument {
  entityType: 'invite'

  /** Non-guessable secret embedded in the RSVP link. */
  inviteToken: string

  email: string

  /** Pre-populated display name from the organizer; participant can override on accept. */
  suggestedName?: string

  /** Language hint for the InviteSent email; participant may change on accept. */
  preferredLanguage?: Language

  status: InviteStatus

  /** ISO 8601 timestamp of the first send. Resends update `lastResentAt`, not this. */
  sentAt: string
  /** ISO 8601 timestamp of the most recent resend, if any. */
  lastResentAt?: string
  /** ISO 8601 timestamp the recipient accepted or declined. */
  respondedAt?: string
  /** ISO 8601 timestamp at which the invite is considered expired. */
  expiresAt?: string

  /**
   * Set when `status === 'accepted'`. References the Participant document
   * created from this invite.
   */
  participantId?: string
}

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

/**
 * Optional structured profile fields per ADR-001.
 *
 * NOTE: No address/shipping fields exist anywhere in this schema. Those are
 * deferred to Phase 3 privacy escrow and must not be added in Phase 1.
 */
export interface ParticipantProfile {
  avatarUrl?: string
  pronouns?: string
  /** Free-form tags; visible to organizer and giver after match reveal. */
  interests?: string[]
  /** Optional clothing/shoe sizes; visible to organizer and giver after match reveal. */
  sizes?: {
    top?: string
    bottom?: string
    shoe?: string
  }
  /** Optional allergens / dietary restrictions; relevant for food-themed exchanges. */
  allergens?: string[]
}

/**
 * A participant who has accepted an Invite. ADR-001: `displayName` is the only
 * required profile field; everything else lives in `profile` and is optional.
 */
export interface Participant extends CosmosDocument {
  entityType: 'participant'

  /** The Invite this participant accepted. */
  inviteId: string

  /** ADR-001: the only required participant profile field. */
  displayName: string

  /** Carried from the accepted Invite. Used for lifecycle email delivery. */
  email: string
  preferredLanguage?: Language

  /** Optional structured profile per ADR-001. */
  profile?: ParticipantProfile

  /**
   * Set true after the participant has acknowledged their Match. Used by
   * reassignment logic (carried forward conceptually from v1; Phase 2 candidate).
   */
  hasConfirmedAssignment?: boolean

  /** ISO 8601 timestamp the participant accepted their invite. */
  joinedAt: string
}

// ---------------------------------------------------------------------------
// WishlistItem
// ---------------------------------------------------------------------------

/**
 * Wishlist priority. String union chosen for readability in API responses and
 * forward-compatibility — new tiers can be added without renumbering. Final
 * shape may be revisited during #10; see plan.md "Open considerations".
 */
export type WishlistPriority = 'high' | 'medium' | 'low'

/**
 * One item on a participant's wishlist. Multi-item per Participant per Exchange.
 * Edits are blocked at the application layer once `Exchange.status === 'matched'`.
 */
export interface WishlistItem extends CosmosDocument {
  entityType: 'wishlistItem'

  /** Owning Participant. */
  participantId: string

  title: string
  url?: string
  notes?: string

  priority: WishlistPriority
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

/**
 * Match reveal state.
 *
 *   pending → revealed
 */
export type MatchRevealStatus = 'pending' | 'revealed'

/**
 * One giver → receiver assignment. Cycle integrity (each Participant appears
 * exactly once as `giver` and once as `receiver` across an Exchange's Match
 * documents) is enforced by the matching engine (#6), not the type system.
 */
export interface Match extends CosmosDocument {
  entityType: 'match'

  giverParticipantId: string
  receiverParticipantId: string

  revealStatus: MatchRevealStatus
  /** ISO 8601 timestamp when this match was revealed to the giver. */
  revealedAt?: string
}

// ---------------------------------------------------------------------------
// NotificationEvent
// ---------------------------------------------------------------------------

/**
 * Lifecycle email types supported in Phase 1. See issue #12.
 */
export type NotificationType =
  | 'inviteSent'
  | 'rsvpAccepted'
  | 'wishlistReminder'
  | 'matchReveal'
  | 'giftByReminder'

/** Delivery status reported by the email provider. */
export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'bounced'

/** Discriminator for the recipient referenced by `recipientRefId`. */
export type NotificationRecipientKind = 'participant' | 'invite' | 'organizer'

/**
 * Idempotency + audit record for a single lifecycle email send.
 *
 * Duplicate prevention: callers MUST check for an existing NotificationEvent
 * with the same `idempotencyKey` before queueing a send. Proposed key shape:
 * `${exchangeId}:${type}:${recipientRefId}` — final format is reviewed during #12.
 */
export interface NotificationEvent extends CosmosDocument {
  entityType: 'notificationEvent'

  type: NotificationType

  /** What kind of entity `recipientRefId` points at. */
  recipientKind: NotificationRecipientKind
  /**
   * Reference to the recipient:
   *   - 'participant' → Participant.id
   *   - 'invite' → Invite.id (used for InviteSent before a Participant exists)
   *   - 'organizer' → Exchange.id (organizer is identified by their magic-link
   *     token, not a separate user record)
   */
  recipientRefId: string
  recipientEmail: string

  status: NotificationStatus

  /** ISO 8601 timestamp when the send was attempted. */
  sentAt: string
  /** Provider-assigned message id, when available. */
  providerMessageId?: string
  /** Provider error detail when status is 'failed' or 'bounced'. */
  failureReason?: string

  /** Stable key used for duplicate-send prevention. See note above. */
  idempotencyKey: string
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Type-narrowing union for any document read from the `exchanges` container.
 * Narrow with the `entityType` discriminator.
 */
export type ExchangeContainerDocument =
  | Exchange
  | Invite
  | Participant
  | WishlistItem
  | Match
  | NotificationEvent

// ---------------------------------------------------------------------------
// Validation bounds (ADR-001)
// ---------------------------------------------------------------------------

/**
 * Phase 1 participant bounds per ADR-001. Enforced by the invite subsystem (#5)
 * and the matching engine (#6); not encoded in the types themselves.
 */
export const PARTICIPANT_BOUNDS = {
  min: 3,
  max: 50,
} as const
