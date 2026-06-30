import { HttpRequest, InvocationContext } from '@azure/functions'
import * as v2Cosmos from '../shared/v2/cosmosdb'
import { Exchange } from '../shared/v2/types'

jest.mock('../shared/v2/cosmosdb')

const mockGetExchangeById = jest.mocked(v2Cosmos.getExchangeById)
const mockQueryExchangeByOrganizerTokenHash = jest.mocked(v2Cosmos.queryExchangeByOrganizerTokenHash)
const mockGetExchangeByCode = jest.mocked(v2Cosmos.getExchangeByCode)
const mockListInvites = jest.mocked(v2Cosmos.listInvitesByExchange)
const mockListParticipants = jest.mocked(v2Cosmos.listParticipantsByExchange)
const mockListWishlistItems = jest.mocked(v2Cosmos.listWishlistItemsByExchange)
const mockListMatches = jest.mocked(v2Cosmos.listMatchesByExchange)
const mockReplaceDocument = jest.mocked(v2Cosmos.replaceDocument)

import { cancelExchangeHandler } from '../functions/v2/cancelExchange'
import { getExchangeHandler } from '../functions/v2/getExchange'
import { getExchangeByCodeHandler } from '../functions/v2/getExchangeByCode'
import { patchExchangeHandler } from '../functions/v2/patchExchange'
import { publishExchangeHandler } from '../functions/v2/publishExchange'
import { completeExchangeHandler } from '../functions/v2/match'

const NOW = new Date('2026-12-01T00:00:00Z').toISOString()

function makeContext(): InvocationContext {
  return {
    invocationId: 'test-ex',
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as InvocationContext
}

function makeExchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    id: 'ex-1',
    exchangeId: 'ex-1',
    entityType: 'exchange',
    code: '123456',
    exchangeType: 'custom',
    status: 'draft',
    name: 'Test',
    exchangeDate: '2026-12-25',
    organizerTokenHash: 'h',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function wireOrganizerAuth(exchange: Exchange): string {
  const { generateToken } = require('../shared/v2/auth')
  const { token, tokenHash } = generateToken(exchange.id)
  exchange.organizerTokenHash = tokenHash
  mockQueryExchangeByOrganizerTokenHash.mockResolvedValue(exchange)
  mockGetExchangeById.mockResolvedValue(exchange)
  return token
}

function organizerRequest(token: string, params: Record<string, string>, body?: any): HttpRequest {
  return {
    query: new URLSearchParams(`organizerToken=${token}`),
    headers: new Map(),
    params,
    json: jest.fn().mockResolvedValue(body || {}),
  } as unknown as HttpRequest
}

function publicRequest(params: Record<string, string>): HttpRequest {
  return {
    query: new URLSearchParams(),
    headers: new Map(),
    params,
  } as unknown as HttpRequest
}

describe('v2 exchange endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReplaceDocument.mockImplementation(async (d: any) => d)
    mockListInvites.mockResolvedValue([])
    mockListParticipants.mockResolvedValue([])
    mockListWishlistItems.mockResolvedValue([])
    mockListMatches.mockResolvedValue([])
  })

  describe('GET /exchanges/by-code/:code', () => {
    it('returns minimal projection for live exchange', async () => {
      mockGetExchangeByCode.mockResolvedValue(makeExchange({ status: 'published' }))
      const res = await getExchangeByCodeHandler(publicRequest({ code: '123456' }), makeContext())
      expect(res.status).toBe(200)
      const body = res.jsonBody as any
      expect(body.id).toBe('ex-1')
      expect(body.code).toBe('123456')
      expect(body.status).toBe('published')
      expect(body).not.toHaveProperty('organizerTokenHash')
      expect(body).not.toHaveProperty('organizerEmail')
    })

    it('returns 400 for non-6-digit codes', async () => {
      const res = await getExchangeByCodeHandler(publicRequest({ code: 'abc' }), makeContext())
      expect(res.status).toBe(400)
    })

    it('returns 404 for cancelled exchange', async () => {
      mockGetExchangeByCode.mockResolvedValue(makeExchange({ status: 'cancelled' }))
      const res = await getExchangeByCodeHandler(publicRequest({ code: '123456' }), makeContext())
      expect(res.status).toBe(404)
    })

    it('returns 404 for missing exchange', async () => {
      mockGetExchangeByCode.mockResolvedValue(null)
      const res = await getExchangeByCodeHandler(publicRequest({ code: '999999' }), makeContext())
      expect(res.status).toBe(404)
    })
  })

  describe('GET /exchanges/:id (organizer)', () => {
    it('returns full exchange + counts', async () => {
      const ex = makeExchange({ status: 'published' })
      const token = wireOrganizerAuth(ex)
      mockListInvites.mockResolvedValue([
        { status: 'sent' } as any,
        { status: 'accepted' } as any,
        { status: 'accepted' } as any,
      ])
      mockListParticipants.mockResolvedValue([{}, {}] as any)

      const res = await getExchangeHandler(organizerRequest(token, { exchangeId: 'ex-1' }), makeContext())
      expect(res.status).toBe(200)
      const body = res.jsonBody as any
      expect(body.exchange.id).toBe('ex-1')
      expect(body.exchange.organizerTokenHash).toBeUndefined()
      expect(body.counts.invites).toBe(3)
      expect(body.counts.acceptedInvites).toBe(2)
      expect(body.counts.participants).toBe(2)
    })

    it('rejects when token does not match requested exchange', async () => {
      const ex = makeExchange()
      const token = wireOrganizerAuth(ex)
      const res = await getExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-other' }),
        makeContext(),
      )
      expect(res.status).toBe(403)
    })
  })

  describe('PATCH /exchanges/:id', () => {
    it('updates editable fields in draft', async () => {
      const ex = makeExchange({ status: 'draft' })
      const token = wireOrganizerAuth(ex)
      const res = await patchExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }, { name: 'Renamed' }),
        makeContext(),
      )
      expect(res.status).toBe(200)
      expect(mockReplaceDocument).toHaveBeenCalledTimes(1)
      const saved = mockReplaceDocument.mock.calls[0][0] as Exchange
      expect(saved.name).toBe('Renamed')
    })

    it('rejects editing immutable fields like code or status', async () => {
      const ex = makeExchange({ status: 'draft' })
      const token = wireOrganizerAuth(ex)
      const res = await patchExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }, { code: '999999' }),
        makeContext(),
      )
      expect(res.status).toBe(400)
      expect(mockReplaceDocument).not.toHaveBeenCalled()
    })

    it('rejects standard-field edits in matched state', async () => {
      const ex = makeExchange({ status: 'matched' })
      const token = wireOrganizerAuth(ex)
      const res = await patchExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }, { name: 'X' }),
        makeContext(),
      )
      expect(res.status).toBe(400)
    })

    it('rejects invalid exchangeDate', async () => {
      const ex = makeExchange({ status: 'draft' })
      const token = wireOrganizerAuth(ex)
      const res = await patchExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }, { exchangeDate: 'bogus' }),
        makeContext(),
      )
      expect(res.status).toBe(400)
    })
  })

  describe('POST /exchanges/:id/publish', () => {
    it('transitions draft → published', async () => {
      const ex = makeExchange({ status: 'draft' })
      const token = wireOrganizerAuth(ex)
      const res = await publishExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }),
        makeContext(),
      )
      expect(res.status).toBe(200)
      const saved = mockReplaceDocument.mock.calls[0][0] as Exchange
      expect(saved.status).toBe('published')
      expect(saved.publishedAt).toBeDefined()
    })

    it('rejects publishing an already-published exchange', async () => {
      const ex = makeExchange({ status: 'published' })
      const token = wireOrganizerAuth(ex)
      const res = await publishExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })
  })

  describe('POST /exchanges/:id/cancel', () => {
    it('cancels a draft exchange', async () => {
      const ex = makeExchange({ status: 'draft' })
      const token = wireOrganizerAuth(ex)
      const res = await cancelExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }),
        makeContext(),
      )
      expect(res.status).toBe(200)
      const saved = mockReplaceDocument.mock.calls[0][0] as Exchange
      expect(saved.status).toBe('cancelled')
    })

    it('cannot cancel a matched exchange', async () => {
      const ex = makeExchange({ status: 'matched' })
      const token = wireOrganizerAuth(ex)
      const res = await cancelExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })
  })

  describe('POST /exchanges/:id/complete', () => {
    it('completes a matched exchange', async () => {
      const ex = makeExchange({ status: 'matched' })
      const token = wireOrganizerAuth(ex)
      const res = await completeExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }),
        makeContext(),
      )
      expect(res.status).toBe(200)
      const saved = mockReplaceDocument.mock.calls[0][0] as Exchange
      expect(saved.status).toBe('completed')
      expect(saved.completedAt).toBeDefined()
    })

    it('cannot complete an unmatched exchange', async () => {
      const ex = makeExchange({ status: 'published' })
      const token = wireOrganizerAuth(ex)
      const res = await completeExchangeHandler(
        organizerRequest(token, { exchangeId: 'ex-1' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })
  })
})
