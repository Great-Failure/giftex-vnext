import { HttpRequest, InvocationContext } from '@azure/functions'
import { recoverOrganizerLinkHandler, __resetRecoverRateLimitForTests } from '../functions/v2/recoverOrganizerLink'
import * as authModule from '../shared/v2/auth'
import * as cosmosModule from '../shared/v2/cosmosdb'
import * as emailModule from '../shared/v2/email'

jest.mock('../shared/v2/auth')
jest.mock('../shared/v2/cosmosdb')
jest.mock('../shared/v2/email')
jest.mock('../shared/telemetry', () => ({
  trackError: jest.fn(),
  trackEvent: jest.fn(),
  ApiErrorCode: {
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  },
  createErrorResponse: jest.fn((_code, message) => ({ message })),
  getHttpStatusForError: jest.fn(() => 500),
}))

const mockCreateOrganizerTokenExpiry = jest.mocked(authModule.createOrganizerTokenExpiry)
const mockGenerateToken = jest.mocked(authModule.generateToken)
const mockQueryExchangesByOrganizerEmail = jest.mocked(cosmosModule.queryExchangesByOrganizerEmail)
const mockReplaceExchange = jest.mocked(cosmosModule.replaceExchange)
const mockSendOrganizerLinkResentEmail = jest.mocked(emailModule.sendOrganizerLinkResentEmail)

const mockExchange = {
  id: 'exchange-1',
  exchangeId: 'exchange-1',
  entityType: 'exchange' as const,
  code: '123456',
  exchangeType: 'custom' as const,
  status: 'published' as const,
  name: 'Exchange',
  exchangeDate: '2026-12-01',
  organizerTokenHash: 'old-hash',
  organizerEmail: 'owner@example.com',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function createRequest(body: unknown, headers?: Record<string, string>) {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: new Map(Object.entries(headers || {})),
  } as unknown as HttpRequest
}

describe('v2 recoverOrganizerLink', () => {
  let mockContext: InvocationContext

  beforeEach(() => {
    jest.clearAllMocks()
    __resetRecoverRateLimitForTests()

    mockContext = {
      invocationId: 'request-id',
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as InvocationContext

    mockGenerateToken.mockReturnValue({ token: 'exchange-1.new-token', tokenHash: 'new-hash' })
    mockCreateOrganizerTokenExpiry.mockReturnValue('2030-01-01T00:00:00.000Z')
    mockReplaceExchange.mockImplementation(async exchange => exchange as any)
    mockSendOrganizerLinkResentEmail.mockResolvedValue({ success: true })
    process.env.APP_BASE_URL = 'https://example.com'
  })

  it('returns 202 and does not send email when exchange is not found', async () => {
    mockQueryExchangesByOrganizerEmail.mockResolvedValue([])

    const response = await recoverOrganizerLinkHandler(
      createRequest({ email: 'missing@example.com', language: 'en' }),
      mockContext,
    )

    expect(response.status).toBe(202)
    expect(response.jsonBody).toEqual({ ok: true })
    expect(mockSendOrganizerLinkResentEmail).not.toHaveBeenCalled()
    expect(mockReplaceExchange).not.toHaveBeenCalled()
  })

  it('rotates organizer token hash and resends link when exchange exists', async () => {
    mockQueryExchangesByOrganizerEmail.mockResolvedValue([{ ...mockExchange }])

    const response = await recoverOrganizerLinkHandler(
      createRequest({ email: 'owner@example.com', language: 'en' }, { 'x-forwarded-for': '10.0.0.1' }),
      mockContext,
    )

    expect(response.status).toBe(202)
    expect(response.jsonBody).toEqual({ ok: true })
    expect(mockReplaceExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        organizerTokenHash: 'new-hash',
        organizerTokenExpiresAt: '2030-01-01T00:00:00.000Z',
      }),
    )
    expect(mockSendOrganizerLinkResentEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exchange-1' }),
      expect.stringContaining('organizer=exchange-1.new-token'),
      'en',
    )
  })

  it('resends links for every exchange owned by the organizer email', async () => {
    mockQueryExchangesByOrganizerEmail.mockResolvedValue([
      { ...mockExchange, id: 'exchange-1', exchangeId: 'exchange-1', code: '111111' },
      { ...mockExchange, id: 'exchange-2', exchangeId: 'exchange-2', code: '222222' },
    ] as any)

    mockGenerateToken
      .mockReturnValueOnce({ token: 'exchange-1.token-1', tokenHash: 'hash-1' })
      .mockReturnValueOnce({ token: 'exchange-2.token-2', tokenHash: 'hash-2' })

    const response = await recoverOrganizerLinkHandler(
      createRequest({ email: 'owner@example.com', language: 'en' }, { 'x-forwarded-for': '10.0.0.1' }),
      mockContext,
    )

    expect(response.status).toBe(202)
    expect(mockReplaceExchange).toHaveBeenCalledTimes(2)
    expect(mockSendOrganizerLinkResentEmail).toHaveBeenCalledTimes(2)
  })

  it('returns 429 after hitting rate limit', async () => {
    mockQueryExchangesByOrganizerEmail.mockResolvedValue([])

    const request = createRequest({ email: 'owner@example.com', language: 'en' }, { 'x-forwarded-for': '192.168.1.9' })

    for (let i = 0; i < 5; i += 1) {
      const response = await recoverOrganizerLinkHandler(request, mockContext)
      expect(response.status).toBe(202)
    }

    const limitedResponse = await recoverOrganizerLinkHandler(request, mockContext)
    expect(limitedResponse.status).toBe(429)
  })
})
