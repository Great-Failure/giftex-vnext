import {
  generateMatches,
  regenerateMatchesWithLocks,
  reassignParticipantMatch,
} from '../shared/v2/matching'
import { Match, Participant } from '../shared/v2/types'

function makeParticipants(n: number, confirmedIndices: number[] = []): Participant[] {
  const now = new Date().toISOString()
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    exchangeId: 'ex1',
    entityType: 'participant' as const,
    inviteId: `inv${i + 1}`,
    displayName: `Participant ${i + 1}`,
    email: `p${i + 1}@example.com`,
    hasConfirmedAssignment: confirmedIndices.includes(i),
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  }))
}

describe('matching.generateMatches', () => {
  it('throws when fewer than 3 participants', () => {
    expect(() => generateMatches('ex1', makeParticipants(2))).toThrow(/at least 3/)
  })

  it('produces N matches for N participants', () => {
    for (const n of [3, 5, 10, 25, 50]) {
      const matches = generateMatches('ex1', makeParticipants(n))
      expect(matches).toHaveLength(n)
    }
  })

  it('never produces a self-match (100-trial stress, n=3..50)', () => {
    for (let trial = 0; trial < 100; trial++) {
      const n = 3 + (trial % 48) // 3..50
      const participants = makeParticipants(n)
      const matches = generateMatches('ex1', participants)
      for (const m of matches) {
        expect(m.giverParticipantId).not.toBe(m.receiverParticipantId)
      }
    }
  })

  it('every participant is exactly one giver and one receiver (cycle integrity)', () => {
    for (let trial = 0; trial < 100; trial++) {
      const n = 3 + (trial % 48)
      const participants = makeParticipants(n)
      const matches = generateMatches('ex1', participants)
      const giverIds = matches.map((m) => m.giverParticipantId).sort()
      const receiverIds = matches.map((m) => m.receiverParticipantId).sort()
      const expected = participants.map((p) => p.id).sort()
      expect(giverIds).toEqual(expected)
      expect(receiverIds).toEqual(expected)
    }
  })

  it('all matches start with revealStatus pending', () => {
    const matches = generateMatches('ex1', makeParticipants(5))
    for (const m of matches) {
      expect(m.revealStatus).toBe('pending')
    }
  })

  it('all matches carry the same exchangeId', () => {
    const matches = generateMatches('ex42', makeParticipants(5))
    for (const m of matches) {
      expect(m.exchangeId).toBe('ex42')
    }
  })
})

describe('matching.regenerateMatchesWithLocks', () => {
  function buildCurrent(participants: Participant[]): Match[] {
    // Simple ring: p1→p2, p2→p3, ..., pN→p1
    const now = new Date().toISOString()
    return participants.map((p, i) => ({
      id: `m${i + 1}`,
      exchangeId: 'ex1',
      entityType: 'match' as const,
      giverParticipantId: p.id,
      receiverParticipantId: participants[(i + 1) % participants.length].id,
      revealStatus: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    }))
  }

  it('throws when fewer than 3 participants', () => {
    expect(() => regenerateMatchesWithLocks('ex1', makeParticipants(2), [])).toThrow(/at least 3/)
  })

  it('returns current matches unchanged when all participants are confirmed', () => {
    const participants = makeParticipants(5, [0, 1, 2, 3, 4])
    const current = buildCurrent(participants)
    const result = regenerateMatchesWithLocks('ex1', participants, current)
    expect(result).toEqual(current)
  })

  it('preserves locked assignments and reshuffles unlocked', () => {
    // p1 + p3 confirmed → their assignments locked.
    const participants = makeParticipants(6, [0, 2])
    const current = buildCurrent(participants)
    const lockedGivers = new Set(['p1', 'p3'])
    const lockedReceivers = new Set([
      current.find((m) => m.giverParticipantId === 'p1')!.receiverParticipantId,
      current.find((m) => m.giverParticipantId === 'p3')!.receiverParticipantId,
    ])

    for (let trial = 0; trial < 50; trial++) {
      const result = regenerateMatchesWithLocks('ex1', participants, current)
      // Check locked matches preserved.
      for (const m of result) {
        if (lockedGivers.has(m.giverParticipantId)) {
          const original = current.find((c) => c.giverParticipantId === m.giverParticipantId)!
          expect(m.receiverParticipantId).toBe(original.receiverParticipantId)
        } else {
          // Unlocked givers must not receive someone who's a locked receiver
          // (otherwise the locked giver would lose their assignment).
          expect(lockedReceivers.has(m.receiverParticipantId)).toBe(false)
        }
        expect(m.giverParticipantId).not.toBe(m.receiverParticipantId)
      }
    }
  })
})

describe('matching.reassignParticipantMatch', () => {
  it('returns the same matches when requester has no current assignment', () => {
    const participants = makeParticipants(4)
    const matches: Match[] = []
    const result = reassignParticipantMatch('p1', matches, participants)
    expect(result).toEqual([])
  })

  it('returns null when no valid swap exists', () => {
    // Trivial 3-person cycle p1→p2→p3→p1 — every swap creates A→A.
    const participants = makeParticipants(3)
    const now = new Date().toISOString()
    const matches: Match[] = [
      { id: 'm1', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p1', receiverParticipantId: 'p2', revealStatus: 'pending', createdAt: now, updatedAt: now },
      { id: 'm2', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p2', receiverParticipantId: 'p3', revealStatus: 'pending', createdAt: now, updatedAt: now },
      { id: 'm3', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p3', receiverParticipantId: 'p1', revealStatus: 'pending', createdAt: now, updatedAt: now },
    ]
    expect(reassignParticipantMatch('p1', matches, participants)).toBeNull()
  })

  it('performs a valid swap when one exists, preserving cycle integrity', () => {
    const participants = makeParticipants(5)
    const now = new Date().toISOString()
    const matches: Match[] = [
      { id: 'm1', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p1', receiverParticipantId: 'p2', revealStatus: 'pending', createdAt: now, updatedAt: now },
      { id: 'm2', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p2', receiverParticipantId: 'p3', revealStatus: 'pending', createdAt: now, updatedAt: now },
      { id: 'm3', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p3', receiverParticipantId: 'p4', revealStatus: 'pending', createdAt: now, updatedAt: now },
      { id: 'm4', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p4', receiverParticipantId: 'p5', revealStatus: 'pending', createdAt: now, updatedAt: now },
      { id: 'm5', exchangeId: 'ex1', entityType: 'match', giverParticipantId: 'p5', receiverParticipantId: 'p1', revealStatus: 'pending', createdAt: now, updatedAt: now },
    ]
    const result = reassignParticipantMatch('p1', matches, participants)
    expect(result).not.toBeNull()
    if (!result) return

    // p1 must have a different receiver now.
    const p1 = result.find((m) => m.giverParticipantId === 'p1')!
    expect(p1.receiverParticipantId).not.toBe('p2')
    expect(p1.giverParticipantId).not.toBe(p1.receiverParticipantId)

    // Cycle integrity preserved.
    const giverIds = result.map((m) => m.giverParticipantId).sort()
    const receiverIds = result.map((m) => m.receiverParticipantId).sort()
    expect(giverIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(receiverIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  })
})
