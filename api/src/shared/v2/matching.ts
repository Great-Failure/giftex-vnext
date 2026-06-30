/**
 * v2 matching engine. Ported from `api/src/shared/game-utils.ts` to operate
 * on Participant[] → Match[] in the v2 data model. Preserves v1 invariants:
 *   - no self-match (giver !== receiver)
 *   - cycle integrity (each participant appears exactly once as giver and
 *     exactly once as receiver)
 *   - lock preservation for confirmed participants (matched re-runs)
 */

import { generateId } from '../game-utils'
import { Match, Participant } from './types'

function newMatch(exchangeId: string, giver: Participant, receiver: Participant): Match {
  const now = new Date().toISOString()
  return {
    id: generateId(),
    exchangeId,
    entityType: 'match',
    giverParticipantId: giver.id,
    receiverParticipantId: receiver.id,
    revealStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Generate fresh circular assignments. Each participant gives to the next
 * after a Fisher–Yates-style shuffle, so no self-match by construction.
 *
 * @throws if fewer than 3 participants.
 */
export function generateMatches(exchangeId: string, participants: Participant[]): Match[] {
  if (participants.length < 3) {
    throw new Error('Need at least 3 participants')
  }
  const shuffled = [...participants].sort(() => Math.random() - 0.5)
  const matches: Match[] = []
  for (let i = 0; i < shuffled.length; i++) {
    const giver = shuffled[i]
    const receiver = shuffled[(i + 1) % shuffled.length]
    matches.push(newMatch(exchangeId, giver, receiver))
  }
  return matches
}

/**
 * Regenerate matches while preserving any "locked" assignments — Matches
 * whose giver participant has `hasConfirmedAssignment === true`. Used for
 * organizer-triggered rematch before any reveals.
 *
 * Strategy ports v1's `generateAssignmentsWithLocks`:
 *   1. Identify locked matches.
 *   2. Remove their givers from the shuffle pool.
 *   3. Remove their receivers from the available-receivers pool.
 *   4. For the remaining (unlocked) givers, retry-shuffle until no
 *      self-match. Fall back to full regeneration after maxAttempts.
 *
 * @throws if fewer than 3 participants.
 */
export function regenerateMatchesWithLocks(
  exchangeId: string,
  participants: Participant[],
  currentMatches: Match[],
): Match[] {
  if (participants.length < 3) {
    throw new Error('Need at least 3 participants')
  }

  const lockedMatches = currentMatches.filter((m) => {
    const giver = participants.find((p) => p.id === m.giverParticipantId)
    return giver?.hasConfirmedAssignment === true
  })

  if (lockedMatches.length === participants.length) {
    return [...currentMatches]
  }
  if (lockedMatches.length === 0) {
    return generateMatches(exchangeId, participants)
  }

  const lockedGiverIds = new Set(lockedMatches.map((m) => m.giverParticipantId))
  const lockedReceiverIds = new Set(lockedMatches.map((m) => m.receiverParticipantId))

  const unlockedGivers = participants.filter((p) => !lockedGiverIds.has(p.id))
  const availableReceiverIds = participants
    .filter((p) => !lockedReceiverIds.has(p.id))
    .map((p) => p.id)

  if (availableReceiverIds.length < unlockedGivers.length) {
    return generateMatches(exchangeId, participants)
  }

  const maxAttempts = 100
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const shuffledGivers = [...unlockedGivers].sort(() => Math.random() - 0.5)
    const shuffledReceiverIds = [...availableReceiverIds].sort(() => Math.random() - 0.5)
    let valid = true
    const candidate: Match[] = []
    for (let i = 0; i < shuffledGivers.length; i++) {
      const giver = shuffledGivers[i]
      const receiverId = shuffledReceiverIds[i]
      if (giver.id === receiverId) {
        valid = false
        break
      }
      const receiver = participants.find((p) => p.id === receiverId)!
      candidate.push(newMatch(exchangeId, giver, receiver))
    }
    if (valid) {
      return [...lockedMatches, ...candidate]
    }
  }

  return generateMatches(exchangeId, participants)
}

/**
 * Single-participant reassignment via swap-with-locks. Ported from v1
 * `reassignParticipant`. Returns the updated matches array, or `null` when
 * no valid swap exists (caller should fall back to regenerateMatchesWithLocks
 * or full rematch).
 *
 * Constraints:
 *   - Cannot swap with self
 *   - Cannot create A → A
 *   - Cannot end up with the same receiver
 *   - After swap, the partner must not give to themselves
 *   - Prefer partners who haven't confirmed their assignment
 */
export function reassignParticipantMatch(
  participantId: string,
  currentMatches: Match[],
  participants: Participant[],
): Match[] | null {
  const requester = currentMatches.find((m) => m.giverParticipantId === participantId)
  if (!requester) return currentMatches

  const currentReceiverId = requester.receiverParticipantId

  const potentialPartners = currentMatches.filter((m) => {
    if (m.giverParticipantId === participantId) return false
    if (m.receiverParticipantId === participantId) return false
    if (m.receiverParticipantId === currentReceiverId) return false
    if (m.giverParticipantId === currentReceiverId) return false
    return true
  })

  if (potentialPartners.length === 0) return null

  const sorted = [...potentialPartners].sort((a, b) => {
    const pa = participants.find((p) => p.id === a.giverParticipantId)
    const pb = participants.find((p) => p.id === b.giverParticipantId)
    return (pa?.hasConfirmedAssignment ? 1 : 0) - (pb?.hasConfirmedAssignment ? 1 : 0)
  })

  const unconfirmedPartners = sorted.filter((m) => {
    const p = participants.find((p) => p.id === m.giverParticipantId)
    return !p?.hasConfirmedAssignment
  })

  const partner =
    unconfirmedPartners.length > 0
      ? unconfirmedPartners[Math.floor(Math.random() * unconfirmedPartners.length)]
      : sorted[Math.floor(Math.random() * sorted.length)]

  const newReceiverForRequester = partner.receiverParticipantId
  const newReceiverForPartner = currentReceiverId
  const now = new Date().toISOString()

  return currentMatches.map((m) => {
    if (m.giverParticipantId === participantId) {
      return { ...m, receiverParticipantId: newReceiverForRequester, updatedAt: now }
    }
    if (m.giverParticipantId === partner.giverParticipantId) {
      return { ...m, receiverParticipantId: newReceiverForPartner, updatedAt: now }
    }
    return m
  })
}
