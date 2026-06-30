import { HttpRequest, InvocationContext } from '@azure/functions'
import {
  ApiAuthErrorCode,
  authenticateRequest,
  createOrganizerTokenExpiry,
  generateToken,
  getOrganizerTokenTtlDays,
  hashToken,
  splitToken,
} from '../shared/v2/auth'
import * as v2Cosmos from '../shared/v2/cosmosdb'
import { Exchange, Invite } from '../shared/v2/types'

jest.mock('../shared/v2/cosmosdb')

const mockGetExchangeById = jest.mocked(v2Cosmos.getExchangeById)
const mockQueryExchangeByOrganizerTokenHash = jest.mocked(v2Cosmos.queryExchangeByOrganizerTokenHash)
const mockQueryInviteByTokenHash = jest.mocked(v2Cosmos.queryInviteByTokenHash)

function createRequest(query?: string, headers?: Record<string, string>) {
  return {
    query: new URLSearchParams(query || ''),
    headers: new Map(Object.entries(headers || {})),
  } as unknown as HttpRequest
}

const baseExchange: Exchange = {
  id: 'exchange-1',
  exchangeId: 'exchange-1',
  entityType: 'exchange',
  code: '123456',
  exchangeType: 'custom',
  status: 'published',
  name: 'Test Exchange',
  exchangeDate: '2026-12-01',
  organizerTokenHash: 'hash',
  organizerEmail: 'organizer@example.com',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const baseInvite: Invite = {
  id: 'invite-1',
  exchangeId: 'exchange-1',
  entityType: 'invite',
  inviteTokenHash: 'hash',
  email: 'guest@example.com',
  status: 'accepted',
  sentAt: new Date().toISOString(),
  participantId: 'participant-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('v2 auth', () => {
  let mockContext: InvocationContext

  beforeEach(() => {
    jest.clearAllMocks()

    mockContext = {
      invocationId: 'request-id',
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as InvocationContext

    delete process.env.AUTH_ORGANIZER_TOKEN_TTL_DAYS
  })

  it('generates token with exchangeId prefix and hashes deterministically', () => {
    const { token, tokenHash } = generateToken('exchange-1')

    expect(token.startsWith('exchange-1.')).toBe(true)
    expect(tokenHash).toBe(hashToken(token))
    expect(splitToken(token)?.exchangeId).toBe('exchange-1')
  })

  it('returns organizer principal for valid organizer token', async () => {
    const organizerToken = 'exchange-1.secret'

    mockQueryExchangeByOrganizerTokenHash.mockResolvedValue({
      ...baseExchange,
      organizerTokenHash: hashToken(organizerToken),
      organizerTokenExpiresAt: createOrganizerTokenExpiry(new Date('2030-01-01T00:00:00.000Z')),
    })

    const principal = await authenticateRequest(
      createRequest('organizerToken=' + encodeURIComponent(organizerToken)),
      mockContext,
    )

    expect(principal.role).toBe('organizer')
    expect(mockQueryExchangeByOrganizerTokenHash).toHaveBeenCalledWith('exchange-1', hashToken(organizerToken))
  })

  it('returns participant principal for valid invite token', async () => {
    const inviteToken = 'exchange-1.guest'

    mockQueryInviteByTokenHash.mockResolvedValue({
      ...baseInvite,
      inviteTokenHash: hashToken(inviteToken),
    })
    mockGetExchangeById.mockResolvedValue(baseExchange)

    const principal = await authenticateRequest(
      createRequest('inviteToken=' + encodeURIComponent(inviteToken)),
      mockContext,
    )

    expect(principal.role).toBe('participant')
    expect(mockQueryInviteByTokenHash).toHaveBeenCalledWith('exchange-1', hashToken(inviteToken))
  })

  it('returns public principal when no token is provided', async () => {
    const principal = await authenticateRequest(createRequest(), mockContext)

    expect(principal).toEqual({ role: 'public' })
  })

  it('throws token_expired for expired organizer token', async () => {
    const organizerToken = 'exchange-1.secret'

    mockQueryExchangeByOrganizerTokenHash.mockResolvedValue({
      ...baseExchange,
      organizerTokenHash: hashToken(organizerToken),
      organizerTokenExpiresAt: '2000-01-01T00:00:00.000Z',
    })

    await expect(
      authenticateRequest(createRequest('organizerToken=' + encodeURIComponent(organizerToken)), mockContext),
    ).rejects.toMatchObject({
      code: ApiAuthErrorCode.TOKEN_EXPIRED,
      status: 401,
    })
  })

  it('uses default organizer token ttl when env is invalid', () => {
    process.env.AUTH_ORGANIZER_TOKEN_TTL_DAYS = 'invalid'

    expect(getOrganizerTokenTtlDays()).toBe(90)
  })
})
