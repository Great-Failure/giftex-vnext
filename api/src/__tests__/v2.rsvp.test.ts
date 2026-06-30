import { HttpRequest, InvocationContext } from '@azure/functions'
import * as v2Cosmos from '../shared/v2/cosmosdb'
import { Exchange, Invite } from '../shared/v2/types'

jest.mock('../shared/v2/cosmosdb')

const mockGetExchangeById = jest.mocked(v2Cosmos.getExchangeById)
const mockQueryInviteByTokenHash = jest.mocked(v2Cosmos.queryInviteByTokenHash)
const mockCreateDocument = jest.mocked(v2Cosmos.createDocument)
const mockReplaceDocument = jest.mocked(v2Cosmos.replaceDocument)

import { acceptInviteHandler, declineInviteHandler, getMyInviteHandler } from '../functions/v2/rsvp'

const NOW = new Date('2026-12-01T00:00:00Z').toISOString()

function makeContext(): InvocationContext {
  return {
    invocationId: 'test-rsvp',
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as InvocationContext
}

function makeRequest(inviteToken: string, body: any = {}): HttpRequest {
  return {
    query: new URLSearchParams(`inviteToken=${inviteToken}`),
    headers: new Map(),
    params: {},
    json: jest.fn().mockResolvedValue(body),
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
    organizerTokenHash: 'h',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeInvite(overrides: Partial<Invite> = {}): Invite {
  return {
    id: 'inv-1',
    exchangeId: 'ex-1',
    entityType: 'invite',
    inviteTokenHash: 'will-replace',
    email: 'guest@example.com',
    status: 'sent',
    sentAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function wireInvite(invite: Invite, exchange: Exchange): string {
  const { generateToken } = require('../shared/v2/auth')
  const { token, tokenHash } = generateToken(exchange.id)
  invite.inviteTokenHash = tokenHash
  mockQueryInviteByTokenHash.mockResolvedValue(invite)
  mockGetExchangeById.mockResolvedValue(exchange)
  return token
}

describe('v2 RSVP handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateDocument.mockImplementation(async (doc: any) => doc)
    mockReplaceDocument.mockImplementation(async (doc: any) => doc)
  })

  describe('GET /invites/me', () => {
    it('returns invite + exchange context, never leaking organizer token hash', async () => {
      const ex = makeExchange()
      const inv = makeInvite()
      const token = wireInvite(inv, ex)

      const res = await getMyInviteHandler(makeRequest(token), makeContext())
      expect(res.status).toBe(200)
      const body = res.jsonBody as any
      expect(body.invite.id).toBe('inv-1')
      expect(body.invite.inviteTokenHash).toBeUndefined()
      expect(body.exchange.id).toBe('ex-1')
      expect(body.exchange).not.toHaveProperty('organizerTokenHash')
    })

    it('rejects without invite token', async () => {
      const res = await getMyInviteHandler(makeRequest(''), makeContext())
      expect([401, 403]).toContain(res.status)
    })
  })

  describe('POST /invites/me/accept', () => {
    it('rejects without displayName', async () => {
      const ex = makeExchange()
      const inv = makeInvite()
      const token = wireInvite(inv, ex)

      const res = await acceptInviteHandler(makeRequest(token, {}), makeContext())
      expect(res.status).toBe(400)
    })

    it('creates Participant + transitions Invite to accepted', async () => {
      const ex = makeExchange()
      const inv = makeInvite()
      const token = wireInvite(inv, ex)

      const res = await acceptInviteHandler(
        makeRequest(token, { displayName: 'Alex' }),
        makeContext(),
      )
      expect(res.status).toBe(200)
      const body = res.jsonBody as any
      expect(body.participant.displayName).toBe('Alex')
      expect(body.participant.exchangeId).toBe('ex-1')
      expect(body.invite.status).toBe('accepted')
      expect(body.invite.participantId).toBe(body.participant.id)
      expect(mockCreateDocument).toHaveBeenCalledTimes(1)
      expect(mockReplaceDocument).toHaveBeenCalledTimes(1)
    })

    it('rejects when exchange is in draft', async () => {
      const ex = makeExchange({ status: 'draft' })
      const inv = makeInvite()
      const token = wireInvite(inv, ex)

      const res = await acceptInviteHandler(
        makeRequest(token, { displayName: 'Alex' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
      expect(mockCreateDocument).not.toHaveBeenCalled()
    })

    it('rejects late-join when requiresApproval but no approvedAt', async () => {
      const ex = makeExchange({ status: 'matching' })
      const inv = makeInvite({ requiresApproval: true })
      const token = wireInvite(inv, ex)

      const res = await acceptInviteHandler(
        makeRequest(token, { displayName: 'Alex' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })

    it('allows late-join when approvedAt is set', async () => {
      const ex = makeExchange({ status: 'matching' })
      const inv = makeInvite({ requiresApproval: true, approvedAt: NOW })
      const token = wireInvite(inv, ex)

      const res = await acceptInviteHandler(
        makeRequest(token, { displayName: 'Late' }),
        makeContext(),
      )
      expect(res.status).toBe(200)
    })

    it('rejects already-accepted invite', async () => {
      const ex = makeExchange()
      const inv = makeInvite({ status: 'accepted', participantId: 'p-existing' })
      const token = wireInvite(inv, ex)

      const res = await acceptInviteHandler(
        makeRequest(token, { displayName: 'X' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })

    it('rejects declined invite', async () => {
      const ex = makeExchange()
      const inv = makeInvite({ status: 'declined' })
      const token = wireInvite(inv, ex)

      const res = await acceptInviteHandler(
        makeRequest(token, { displayName: 'X' }),
        makeContext(),
      )
      expect(res.status).toBe(409)
    })
  })

  describe('POST /invites/me/decline', () => {
    it('marks invite declined', async () => {
      const ex = makeExchange()
      const inv = makeInvite()
      const token = wireInvite(inv, ex)

      const res = await declineInviteHandler(makeRequest(token), makeContext())
      expect(res.status).toBe(200)
      const body = res.jsonBody as any
      expect(body.invite.status).toBe('declined')
      expect(body.invite.respondedAt).toBeDefined()
    })

    it('rejects already-accepted invite', async () => {
      const ex = makeExchange()
      const inv = makeInvite({ status: 'accepted', participantId: 'p-existing' })
      const token = wireInvite(inv, ex)

      const res = await declineInviteHandler(makeRequest(token), makeContext())
      expect(res.status).toBe(409)
    })

    it('rejects already-declined invite', async () => {
      const ex = makeExchange()
      const inv = makeInvite({ status: 'declined' })
      const token = wireInvite(inv, ex)

      const res = await declineInviteHandler(makeRequest(token), makeContext())
      expect(res.status).toBe(409)
    })
  })
})
