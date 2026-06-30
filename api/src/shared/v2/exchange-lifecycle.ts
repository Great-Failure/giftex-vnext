/**
 * Exchange lifecycle state machine.
 *
 * Allowed transitions:
 *   draft     → published | cancelled
 *   published → matching  | cancelled
 *   matching  → matched
 *   matched   → completed
 *   completed → (terminal)
 *   cancelled → (terminal)
 *
 * Per-field edit gating:
 *   Always editable          : (none — caller must specify)
 *   draft|published          : name, description, exchangeDate, exchangeTime,
 *                              location, generalNotes, budget, maxParticipants,
 *                              organizerEmail, organizerLanguage, revealAt
 *   draft|published|matching : rsvpDeadline, wishlistDeadline
 *   matched|completed|cancelled : nothing (frozen)
 */

import { ExchangeStatus, Exchange } from './types'

export class LifecycleError extends Error {
  constructor(
    public readonly code: 'INVALID_TRANSITION' | 'FIELD_FROZEN',
    message: string,
  ) {
    super(message)
  }
}

const ALLOWED_TRANSITIONS: Record<ExchangeStatus, readonly ExchangeStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['matching', 'cancelled'],
  matching: ['matched'],
  matched: ['completed'],
  completed: [],
  cancelled: [],
}

export function assertTransition(from: ExchangeStatus, to: ExchangeStatus): void {
  if (from === to) {
    throw new LifecycleError('INVALID_TRANSITION', `Exchange is already in status '${to}'`)
  }

  const allowed = ALLOWED_TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    throw new LifecycleError(
      'INVALID_TRANSITION',
      `Invalid exchange status transition: '${from}' → '${to}'. Allowed from '${from}': ${
        allowed.length ? allowed.join(', ') : '(terminal — no transitions allowed)'
      }`,
    )
  }
}

/** Fields that can only be edited in `draft` or `published`. */
const EDITABLE_DRAFT_PUBLISHED: ReadonlyArray<keyof Exchange> = [
  'name',
  'description',
  'exchangeType',
  'exchangeDate',
  'exchangeTime',
  'location',
  'generalNotes',
  'budget',
  'maxParticipants',
  'organizerEmail',
  'organizerLanguage',
  'revealAt',
]

/** Fields editable through `matching` (deadlines that affect in-flight RSVPs). */
const EDITABLE_THROUGH_MATCHING: ReadonlyArray<keyof Exchange> = ['rsvpDeadline', 'wishlistDeadline']

const ALWAYS_FROZEN: ReadonlyArray<keyof Exchange> = [
  'id',
  'exchangeId',
  'entityType',
  'createdAt',
  'updatedAt',
  'code',
  'status',
  'organizerTokenHash',
  'organizerTokenExpiresAt',
  'publishedAt',
  'matchingStartedAt',
  'matchedAt',
  'completedAt',
  'cancelledAt',
]

/**
 * Validate that every field in `patch` is permitted to be edited given the
 * current `status`. Throws `LifecycleError('FIELD_FROZEN', ...)` on the
 * first disallowed field.
 *
 * Status changes are NOT handled here — those go through `assertTransition`
 * and dedicated endpoints (publish, cancel, match, complete).
 */
export function assertPatchAllowed(status: ExchangeStatus, patch: Partial<Exchange>): void {
  const keys = Object.keys(patch) as Array<keyof Exchange>

  for (const key of keys) {
    if (ALWAYS_FROZEN.includes(key)) {
      throw new LifecycleError('FIELD_FROZEN', `Field '${String(key)}' is not editable through PATCH`)
    }

    const editableInDraftPublished = EDITABLE_DRAFT_PUBLISHED.includes(key)
    const editableThroughMatching = EDITABLE_THROUGH_MATCHING.includes(key)

    if (editableInDraftPublished) {
      if (status !== 'draft' && status !== 'published') {
        throw new LifecycleError(
          'FIELD_FROZEN',
          `Field '${String(key)}' is only editable while exchange status is 'draft' or 'published' (current: '${status}')`,
        )
      }
      continue
    }

    if (editableThroughMatching) {
      if (status !== 'draft' && status !== 'published' && status !== 'matching') {
        throw new LifecycleError(
          'FIELD_FROZEN',
          `Field '${String(key)}' is only editable while exchange status is 'draft', 'published', or 'matching' (current: '${status}')`,
        )
      }
      continue
    }

    throw new LifecycleError('FIELD_FROZEN', `Field '${String(key)}' is not a recognized editable field`)
  }
}
