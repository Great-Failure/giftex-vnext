import { HttpRequest, InvocationContext } from '@azure/functions'
import * as v2Cosmos from '../shared/v2/cosmosdb'
import { Exchange, Invite, WishlistItem } from '../shared/v2/types'

jest.mock('../shared/v2/cosmosdb')

const mockGetExchangeById = jest.mocked(v2Cosmos.getExchangeById)
const mockQueryInviteByTokenHash = jest.mocked(v2Cosmos.queryInviteByTokenHash)
const mockCreateDocument = jest.mocked(v2Cosmos.createDocument)
const mockListMyWishlist = jest.mocked(v2Cosmos.listWishlistItemsByParticipant)

import { createWishlistItemHandler, listMyWishlistHandler } from '../functions/v2/wishlist'

const NOW = new Date('2026-12-01T00:00:00Z').toISOString()

function makeContext(): InvocationContext {
  return {
    invocationId: 'test-wishlist',
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as InvocationContext
}

function makeRequest(inviteToken: string, body: any = {}, params: any = {}): HttpRequest {
  return {
    query: new URLSearchParams(inviteToken ? `inviteToken=${inviteToken}` : ''),
    headers: new Map(),
    params,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as HttpRequest
}

function wireParticipantAuth(
  exchangeStatus: Exchange['status'],
  participantId: string | null = 'p-1',
): string {
  const { generateToken } = require('../shared/v2/auth')
  const exchangeId = 'ex-1'
  const { token, tokenHash } = generateToken(exchangeId)
  const exchange: Exchange = {
    id: exchangeId,
    exchangeId,
    entityType: 'exchange',
    code: '100000',
    exchangeType: 'custom',
    status: exchangeStatus,
    name: 'Test',
    exchangeDate: '2026-12-25',
    organizerTokenHash: 'h',
    createdAt: NOW,
    updatedAt: NOW,
  }
  const invite: Invite = {
    id: 'inv-1',
    exchangeId,
    entityType: 'invite',
    inviteTokenHash: tokenHash,
    email: 'guest@example.com',
    status: participantId ? 'accepted' : 'sent',
    sentAt: NOW,
    participantId: participantId === null ? undefined : participantId,
    createdAt: NOW,
    updatedAt: NOW,
  }
  mockQueryInviteByTokenHash.mockResolvedValue(invite)
  mockGetExchangeById.mockResolvedValue(exchange)
  return token
}

describe('v2 wishlist handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateDocument.mockImplementation(async (doc: any) => doc)
    mockListMyWishlist.mockResolvedValue([])
  })

  describe('POST /participants/me/wishlist', () => {
    it('creates a wishlist item for an accepted participant in published state', async () => {
      const token = wireParticipantAuth('published')
      const res = await createWishlistItemHandler(
        makeRequest(token, { title: 'Headphones', priority: 'high', url: '  https://example.com  ' }),
        makeContext(),
      )
      expect(res.status).toBe(201)
      const body = res.jsonBody as any
      expect(body.item.title).toBe('Headphones')
      expect(body.item.priority).toBe('high')
      expect(body.item.url).toBe('https://example.com')
      expect(body.item.participantId).toBe('p-1')
      expect(body.item.exchangeId).toBe('ex-1')
    })

    it('defaults priority to medium when not provided', async () => {
      const token = wireParticipantAuth('published')
      const res = await createWishlistItemHandler(
        makeRequest(token, { title: 'Book' }),
        makeContext(),
      )
      expect(res.status).toBe(201)
      expect((res.jsonBody as any).item.priority).toBe('medium')
    })

    it('rejects when title is missing', async () => {
      const token = wireParticipantAuth('published')
      const res = await createWishlistItemHandler(
        makeRequest(token, { priority: 'low' }),
        makeContext(),
      )
      expect(res.status).toBe(400)
      expect(mockCreateDocument).not.toHaveBeenCalled()
    })

    it('rejects invalid priority', async () => {
      const token = wireParticipantAuth('published')
      const res = await createWishlistItemHandler(
        makeRequest(token, { title: 'X', priority: 'urgent' as any }),
        makeContext(),
      )
      expect(res.status).toBe(400)
    })

    it('rejects when invite is not yet accepted (no participantId)', async () => {
      const token = wireParticipantAuth('published', null)
      const res = await createWishlistItemHandler(
        makeRequest(token, { title: 'X' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })

    it('rejects when exchange is matched (frozen)', async () => {
      const token = wireParticipantAuth('matched')
      const res = await createWishlistItemHandler(
        makeRequest(token, { title: 'X' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
      expect(mockCreateDocument).not.toHaveBeenCalled()
    })

    it('rejects when exchange is completed (frozen)', async () => {
      const token = wireParticipantAuth('completed')
      const res = await createWishlistItemHandler(
        makeRequest(token, { title: 'X' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })

    it('rejects without invite token (public role)', async () => {
      const res = await createWishlistItemHandler(
        makeRequest('', { title: 'X' }),
        makeContext(),
      )
      expect([401, 403]).toContain(res.status)
    })
  })

  describe('GET /participants/me/wishlist', () => {
    it('lists own items for accepted participant', async () => {
      const token = wireParticipantAuth('published')
      const items: WishlistItem[] = [
        {
          id: 'w1',
          exchangeId: 'ex-1',
          entityType: 'wishlistItem',
          participantId: 'p-1',
          title: 'A',
          priority: 'high',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]
      mockListMyWishlist.mockResolvedValue(items)

      const res = await listMyWishlistHandler(makeRequest(token), makeContext())
      expect(res.status).toBe(200)
      expect((res.jsonBody as any).items).toHaveLength(1)
    })

    it('returns empty list when invite not accepted', async () => {
      const token = wireParticipantAuth('published', null)
      const res = await listMyWishlistHandler(makeRequest(token), makeContext())
      expect(res.status).toBe(200)
      expect((res.jsonBody as any).items).toEqual([])
    })
  })
})
