import {
  assertPatchAllowed,
  assertTransition,
  LifecycleError,
} from '../shared/v2/exchange-lifecycle'
import { ExchangeStatus } from '../shared/v2/types'

describe('exchange-lifecycle.assertTransition', () => {
  const validTransitions: Array<[ExchangeStatus, ExchangeStatus]> = [
    ['draft', 'published'],
    ['draft', 'cancelled'],
    ['published', 'matching'],
    ['published', 'cancelled'],
    ['matching', 'matched'],
    ['matched', 'completed'],
  ]

  it.each(validTransitions)('allows %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow()
  })

  const invalidTransitions: Array<[ExchangeStatus, ExchangeStatus]> = [
    ['draft', 'matched'],
    ['draft', 'matching'],
    ['draft', 'completed'],
    ['published', 'matched'],
    ['published', 'completed'],
    ['matching', 'cancelled'],
    ['matched', 'cancelled'],
    ['matched', 'matching'],
    ['completed', 'cancelled'],
    ['completed', 'matched'],
    ['cancelled', 'published'],
    ['cancelled', 'draft'],
  ]

  it.each(invalidTransitions)('rejects %s → %s with INVALID_TRANSITION', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(LifecycleError)
    try {
      assertTransition(from, to)
    } catch (e) {
      expect((e as LifecycleError).code).toBe('INVALID_TRANSITION')
    }
  })

  it('rejects same-state transition', () => {
    expect(() => assertTransition('published', 'published')).toThrow(LifecycleError)
  })

  it('terminal states have no allowed transitions', () => {
    expect(() => assertTransition('completed', 'draft')).toThrow(LifecycleError)
    expect(() => assertTransition('cancelled', 'draft')).toThrow(LifecycleError)
  })
})

describe('exchange-lifecycle.assertPatchAllowed', () => {
  it('allows editing standard fields in draft', () => {
    expect(() =>
      assertPatchAllowed('draft', { name: 'X', description: 'Y', maxParticipants: 10, revealAt: '2026-12-01T00:00:00Z' }),
    ).not.toThrow()
  })

  it('allows editing standard fields in published', () => {
    expect(() =>
      assertPatchAllowed('published', { exchangeDate: '2026-12-25', location: 'HQ' }),
    ).not.toThrow()
  })

  it('rejects editing standard fields in matching', () => {
    expect(() => assertPatchAllowed('matching', { name: 'X' })).toThrow(LifecycleError)
  })

  it('allows editing deadlines through matching', () => {
    expect(() =>
      assertPatchAllowed('matching', { rsvpDeadline: '2026-12-20T00:00:00Z' }),
    ).not.toThrow()
    expect(() =>
      assertPatchAllowed('published', { wishlistDeadline: '2026-12-22T00:00:00Z' }),
    ).not.toThrow()
  })

  it('rejects editing deadlines in matched', () => {
    expect(() => assertPatchAllowed('matched', { rsvpDeadline: '2026-12-20T00:00:00Z' })).toThrow(LifecycleError)
  })

  it('freezes all fields in completed / cancelled', () => {
    expect(() => assertPatchAllowed('completed', { name: 'X' })).toThrow(LifecycleError)
    expect(() => assertPatchAllowed('cancelled', { rsvpDeadline: 'x' })).toThrow(LifecycleError)
  })

  it('rejects always-frozen fields even in draft', () => {
    expect(() => assertPatchAllowed('draft', { id: 'forged' } as any)).toThrow(LifecycleError)
    expect(() => assertPatchAllowed('draft', { code: '999999' } as any)).toThrow(LifecycleError)
    expect(() =>
      assertPatchAllowed('draft', { organizerTokenHash: 'forged' } as any),
    ).toThrow(LifecycleError)
    expect(() => assertPatchAllowed('draft', { status: 'published' } as any)).toThrow(LifecycleError)
  })

  it('rejects unknown fields', () => {
    expect(() => assertPatchAllowed('draft', { unknownField: 'x' } as any)).toThrow(LifecycleError)
  })
})
