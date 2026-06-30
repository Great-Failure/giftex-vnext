import { HttpRequest, InvocationContext } from '@azure/functions'
import { meHandler } from '../functions/v2/me'
import * as authModule from '../shared/v2/auth'

jest.mock('../shared/v2/auth')
jest.mock('../shared/telemetry', () => ({
  trackError: jest.fn(),
  trackEvent: jest.fn(),
  ApiErrorCode: {
    UNAUTHORIZED: 'UNAUTHORIZED',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  },
  createErrorResponse: jest.fn((_code, message) => ({ message })),
  getHttpStatusForError: jest.fn(() => 500),
}))

const mockAuthenticateRequest = jest.mocked(authModule.authenticateRequest)

describe('v2 me endpoint', () => {
  let mockContext: InvocationContext

  beforeEach(() => {
    jest.clearAllMocks()
    mockContext = {
      invocationId: 'request-id',
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as InvocationContext
  })

  it('returns public role when no auth token is provided', async () => {
    mockAuthenticateRequest.mockResolvedValue({ role: 'public' })

    const response = await meHandler({} as HttpRequest, mockContext)

    expect(response.status).toBe(200)
    expect(response.jsonBody).toEqual({ role: 'public' })
  })

  it('returns organizer context for organizer principal', async () => {
    mockAuthenticateRequest.mockResolvedValue({
      role: 'organizer',
      exchangeId: 'exchange-1',
      exchange: {
        id: 'exchange-1',
        name: 'Exchange',
        organizerTokenExpiresAt: '2030-01-01T00:00:00.000Z',
      },
    } as any)

    const response = await meHandler({} as HttpRequest, mockContext)

    expect(response.status).toBe(200)
    expect(response.jsonBody).toEqual({
      role: 'organizer',
      exchangeId: 'exchange-1',
      principalId: 'exchange-1',
      exchangeName: 'Exchange',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      participantId: undefined,
    })
  })
})
