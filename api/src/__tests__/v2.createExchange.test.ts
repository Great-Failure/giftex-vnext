import { HttpRequest, InvocationContext } from '@azure/functions'
import * as v2Cosmos from '../shared/v2/cosmosdb'
import * as v2Email from '../shared/v2/email'
import { Exchange } from '../shared/v2/types'

jest.mock('../shared/v2/cosmosdb')
jest.mock('../shared/v2/email')

const mockCreateDocument = jest.mocked(v2Cosmos.createDocument)
const mockGetExchangeByCode = jest.mocked(v2Cosmos.getExchangeByCode)
const mockSendOrganizerEmail = jest.mocked(v2Email.sendOrganizerLinkCreatedEmail)

// Import handler AFTER mocks are wired up.
import { createExchangeHandler } from '../functions/v2/createExchange'

function makeRequest(body: any): HttpRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as HttpRequest
}

function makeContext(): InvocationContext {
  return {
    invocationId: 'test-' + Math.random().toString(36).slice(2, 8),
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as InvocationContext
}

describe('v2 createExchange handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetExchangeByCode.mockResolvedValue(null)
    mockCreateDocument.mockImplementation(async (doc: any) => doc)
    mockSendOrganizerEmail.mockResolvedValue({ success: true, skipped: true })
  })

  it('creates an exchange and returns the organizer token once', async () => {
    const res = await createExchangeHandler(
      makeRequest({
        name: '  Holiday Swap  ',
        exchangeDate: '2026-12-15',
        organizerEmail: 'org@example.com',
      }),
      makeContext(),
    )

    expect(res.status).toBe(201)
    const body = res.jsonBody as any
    expect(body.exchange.name).toBe('Holiday Swap')
    expect(body.exchange.status).toBe('draft')
    expect(body.exchange.code).toMatch(/^\d{6}$/)
    expect(body.exchange.organizerTokenHash).toBeUndefined() // not leaked
    expect(body.organizerToken).toMatch(new RegExp(`^${body.exchange.id}\\.`))
    expect(mockCreateDocument).toHaveBeenCalledTimes(1)
    const persisted = mockCreateDocument.mock.calls[0][0] as Exchange
    expect(persisted.organizerTokenHash).toBeDefined()
    expect(persisted.organizerTokenHash.length).toBeGreaterThan(0)
    expect(persisted.organizerTokenExpiresAt).toBeDefined()
  })

  it('retries on code collision until a free code is found', async () => {
    mockGetExchangeByCode
      .mockResolvedValueOnce({ id: 'taken' } as any)
      .mockResolvedValueOnce({ id: 'also-taken' } as any)
      .mockResolvedValueOnce(null)

    const res = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: '2026-12-15' }),
      makeContext(),
    )
    expect(res.status).toBe(201)
    expect(mockGetExchangeByCode).toHaveBeenCalledTimes(3)
  })

  it('rejects when name is missing', async () => {
    const res = await createExchangeHandler(
      makeRequest({ exchangeDate: '2026-12-15' }),
      makeContext(),
    )
    expect(res.status).toBe(400)
    expect(mockCreateDocument).not.toHaveBeenCalled()
  })

  it('rejects when exchangeDate is missing', async () => {
    const res = await createExchangeHandler(makeRequest({ name: 'X' }), makeContext())
    expect(res.status).toBe(400)
  })

  it('rejects when exchangeDate is malformed', async () => {
    const res = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: 'not-a-date' }),
      makeContext(),
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid organizer email', async () => {
    const res = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: '2026-12-15', organizerEmail: 'not-an-email' }),
      makeContext(),
    )
    expect(res.status).toBe(400)
  })

  it('rejects maxParticipants out of bounds', async () => {
    const tooLow = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: '2026-12-15', maxParticipants: 2 }),
      makeContext(),
    )
    expect(tooLow.status).toBe(400)
    const tooHigh = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: '2026-12-15', maxParticipants: 51 }),
      makeContext(),
    )
    expect(tooHigh.status).toBe(400)
  })

  it('rejects unparseable revealAt', async () => {
    const res = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: '2026-12-15', revealAt: 'not-a-timestamp' }),
      makeContext(),
    )
    expect(res.status).toBe(400)
  })

  it('returns 500 when createDocument throws', async () => {
    mockCreateDocument.mockRejectedValue(new Error('Cosmos exploded'))
    const res = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: '2026-12-15' }),
      makeContext(),
    )
    expect(res.status).toBe(500)
  })

  it('treats organizer email failure as non-fatal', async () => {
    mockSendOrganizerEmail.mockResolvedValue({ success: false, error: 'ACS down' })
    const res = await createExchangeHandler(
      makeRequest({ name: 'X', exchangeDate: '2026-12-15', organizerEmail: 'org@example.com' }),
      makeContext(),
    )
    expect(res.status).toBe(201)
    expect(mockCreateDocument).toHaveBeenCalledTimes(1)
  })
})
