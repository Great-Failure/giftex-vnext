import { HttpRequest, InvocationContext } from '@azure/functions'
import * as v2Cosmos from '../shared/v2/cosmosdb'
import * as v2Email from '../shared/v2/email'
import { Exchange, Invite, Participant, Match } from '../shared/v2/types'

jest.mock('../shared/v2/cosmosdb')
jest.mock('../shared/v2/email')

const mockGetExchangeById = jest.mocked(v2Cosmos.getExchangeById)
const mockQueryExchangeByOrganizerTokenHash = jest.mocked(v2Cosmos.queryExchangeByOrganizerTokenHash)
const mockListParticipants = jest.mocked(v2Cosmos.listParticipantsByExchange)
const mockListMatches = jest.mocked(v2Cosmos.listMatchesByExchange)
const mockListInvites = jest.mocked(v2Cosmos.listInvitesByExchange)
const mockReplaceDocument = jest.mocked(v2Cosmos.replaceDocument)
const mockCreateDocument = jest.mocked(v2Cosmos.createDocument)
const mockDeleteDocument = jest.mocked(v2Cosmos.deleteDocument)
const mockSendRevealEmail = jest.mocked(v2Email.sendMatchRevealEmail)

import { runMatchHandler } from '../functions/v2/match'

const NOW = new Date('2026-12-01T00:00:00Z').toISOString()

function makeContext(): InvocationContext {
  return {
    invocationId: 'test-match',
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as InvocationContext
}

function makeOrganizerRequest(exchangeId: string, organizerToken: string): HttpRequest {
  return {
    query: new URLSearchParams(`organizerToken=${organizerToken}`),
    headers: new Map(),
    params: { exchangeId },
    json: jest.fn().mockResolvedValue({}),
  } as unknown as HttpRequest
}

function makeExchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    id: 'ex-1',
    exchangeId: 'ex-1',
    entityType: 'exchange',
    code: '100000',
    exchangeType: 'custom',
    status: 'published',
    name: 'Test',
    exchangeDate: '2026-12-25',
    organizerTokenHash: 'will-replace',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeParticipants(n: number): Participant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    exchangeId: 'ex-1',
    entityType: 'participant' as const,
    inviteId: `inv${i + 1}`,
    displayName: `P${i + 1}`,
    email: `p${i + 1}@example.com`,
    joinedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }))
}

describe('v2 runMatch handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListMatches.mockResolvedValue([])
    mockListInvites.mockResolvedValue([])
    mockDeleteDocument.mockResolvedValue()
    mockCreateDocument.mockImplementation(async (doc: any) => doc)
    mockReplaceDocument.mockImplementation(async (doc: any) => doc)
    mockSendRevealEmail.mockResolvedValue({ success: true, skipped: true })
  })

  function wireAuth(exchange: Exchange): string {
    const { generateToken } = require('../shared/v2/auth')
    const { token, tokenHash } = generateToken(exchange.id)
    exchange.organizerTokenHash = tokenHash
    mockQueryExchangeByOrganizerTokenHash.mockResolvedValue(exchange)
    mockGetExchangeById.mockResolvedValue(exchange)
    return token
  }

  it('rejects with 400 when fewer than 3 participants', async () => {
    const ex = makeExchange()
    const token = wireAuth(ex)
    mockListParticipants.mockResolvedValue(makeParticipants(2))

    const res = await runMatchHandler(makeOrganizerRequest('ex-1', token), makeContext())
    expect(res.status).toBe(400)
  })

  it('rejects when above maxParticipants', async () => {
    const ex = makeExchange({ maxParticipants: 5 })
    const token = wireAuth(ex)
    mockListParticipants.mockResolvedValue(makeParticipants(6))

    const res = await runMatchHandler(makeOrganizerRequest('ex-1', token), makeContext())
    expect(res.status).toBe(400)
  })

  it('rejects with 409 when status is not published', async () => {
    const ex = makeExchange({ status: 'draft' })
    const token = wireAuth(ex)
    mockListParticipants.mockResolvedValue(makeParticipants(5))

    const res = await runMatchHandler(makeOrganizerRequest('ex-1', token), makeContext())
    expect(res.status).toBe(409)
  })

  it('happy path: transitions to matched, writes N matches, immediate reveal when revealAt unset', async () => {
    const ex = makeExchange()
    const token = wireAuth(ex)
    const participants = makeParticipants(5)
    mockListParticipants.mockResolvedValue(participants)

    const res = await runMatchHandler(makeOrganizerRequest('ex-1', token), makeContext())
    expect(res.status).toBe(200)
    const body = res.jsonBody as any
    expect(body.exchange.status).toBe('matched')
    expect(body.matches).toHaveLength(5)
    // Two replace calls on the exchange: published → matching, matching → matched.
    expect(mockReplaceDocument).toHaveBeenCalled()
    // 5 createDocument for matches + 5 replaceDocument for reveal status updates.
    const matchCreates = mockCreateDocument.mock.calls.filter((c) => (c[0] as any).entityType === 'match')
    expect(matchCreates).toHaveLength(5)
    // Reveal email sent for each match.
    expect(mockSendRevealEmail).toHaveBeenCalledTimes(5)
    // All matches end up with revealedAt set in the response.
    for (const m of body.matches as Match[]) {
      expect(m.revealStatus).toBe('revealed')
      expect(m.revealedAt).toBeDefined()
    }
  })

  it('defers reveal when revealAt is in the future', async () => {
    const futureRevealAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const ex = makeExchange({ revealAt: futureRevealAt })
    const token = wireAuth(ex)
    mockListParticipants.mockResolvedValue(makeParticipants(4))

    const res = await runMatchHandler(makeOrganizerRequest('ex-1', token), makeContext())
    expect(res.status).toBe(200)
    expect(mockSendRevealEmail).not.toHaveBeenCalled()
    const body = res.jsonBody as any
    for (const m of body.matches as Match[]) {
      expect(m.revealStatus).toBe('pending')
      expect(m.revealedAt).toBeUndefined()
    }
  })

  it('cleans up prior Match documents before writing new ones', async () => {
    const ex = makeExchange()
    const token = wireAuth(ex)
    const stale: Match[] = [
      {
        id: 'old-m1',
        exchangeId: 'ex-1',
        entityType: 'match',
        giverParticipantId: 'x',
        receiverParticipantId: 'y',
        revealStatus: 'pending',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]
    mockListMatches.mockResolvedValue(stale)
    mockListParticipants.mockResolvedValue(makeParticipants(3))

    await runMatchHandler(makeOrganizerRequest('ex-1', token), makeContext())
    expect(mockDeleteDocument).toHaveBeenCalledWith('old-m1', 'ex-1')
  })

  it('returns 401 with bad organizer token', async () => {
    mockQueryExchangeByOrganizerTokenHash.mockResolvedValue(null)
    const res = await runMatchHandler(makeOrganizerRequest('ex-1', 'ex-1.bogus'), makeContext())
    expect([401, 403]).toContain(res.status)
  })

  // Suppress unused-import warning for Invite (helps when extending tests).
  void {} as unknown as Invite
})
