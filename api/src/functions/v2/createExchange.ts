import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { generateGameCode, generateId, validateDateString } from '../../shared/game-utils'
import { ApiErrorCode, createErrorResponse, getHttpStatusForError, trackError, trackEvent } from '../../shared/telemetry'
import {
  createDocument,
  getExchangeByCode,
} from '../../shared/v2/cosmosdb'
import { createOrganizerTokenExpiry, generateToken } from '../../shared/v2/auth'
import { sendOrganizerLinkCreatedEmail } from '../../shared/v2/email'
import { Exchange, ExchangeBudget, Language } from '../../shared/v2/types'
import { internalErrorResponse, validationErrorResponse } from '../../shared/v2/http'

const SUPPORTED_LANGUAGES: ReadonlyArray<Language> = ['en', 'es', 'pt', 'fr', 'it', 'ja', 'zh', 'de', 'nl']
const CODE_GENERATION_MAX_RETRIES = 8

interface CreateExchangePayload {
  name: string
  description?: string
  exchangeDate: string
  exchangeTime?: string
  location?: string
  generalNotes?: string
  budget?: ExchangeBudget
  rsvpDeadline?: string
  wishlistDeadline?: string
  organizerEmail?: string
  organizerLanguage?: Language
  maxParticipants?: number
  revealAt?: string
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

async function generateUniqueCode(): Promise<string> {
  for (let i = 0; i < CODE_GENERATION_MAX_RETRIES; i++) {
    const code = generateGameCode()
    const existing = await getExchangeByCode(code)
    if (!existing) {
      return code
    }
  }
  throw new Error('Failed to generate a unique exchange code after retries')
}

export async function createExchangeHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId

  try {
    const body = (await request.json()) as CreateExchangePayload

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return validationErrorResponse('Exchange name is required', requestId)
    }
    if (!body.exchangeDate || typeof body.exchangeDate !== 'string') {
      return validationErrorResponse('Exchange date is required', requestId)
    }

    const dateValidation = validateDateString(body.exchangeDate)
    if (!dateValidation.valid) {
      return validationErrorResponse(dateValidation.error, requestId)
    }

    if (body.organizerEmail && !isValidEmail(body.organizerEmail)) {
      return validationErrorResponse('Organizer email is not a valid email address', requestId)
    }

    if (body.organizerLanguage && !SUPPORTED_LANGUAGES.includes(body.organizerLanguage)) {
      return validationErrorResponse(`Unsupported organizer language: ${body.organizerLanguage}`, requestId)
    }

    if (body.maxParticipants !== undefined) {
      if (!Number.isInteger(body.maxParticipants) || body.maxParticipants < 3 || body.maxParticipants > 50) {
        return validationErrorResponse('maxParticipants must be an integer between 3 and 50', requestId)
      }
    }

    if (body.revealAt && Number.isNaN(Date.parse(body.revealAt))) {
      return validationErrorResponse('revealAt must be an ISO 8601 timestamp', requestId)
    }

    const id = generateId()
    const code = await generateUniqueCode()
    const { token: rawOrganizerToken, tokenHash: organizerTokenHash } = generateToken(id)
    const now = new Date().toISOString()

    const exchange: Exchange = {
      id,
      exchangeId: id,
      entityType: 'exchange',
      code,
      exchangeType: 'custom',
      status: 'draft',
      name: body.name.trim(),
      description: body.description,
      exchangeDate: body.exchangeDate,
      exchangeTime: body.exchangeTime,
      location: body.location,
      generalNotes: body.generalNotes,
      budget: body.budget,
      rsvpDeadline: body.rsvpDeadline,
      wishlistDeadline: body.wishlistDeadline,
      organizerTokenHash,
      organizerTokenExpiresAt: createOrganizerTokenExpiry(),
      organizerEmail: body.organizerEmail,
      organizerLanguage: body.organizerLanguage,
      maxParticipants: body.maxParticipants,
      revealAt: body.revealAt,
      createdAt: now,
      updatedAt: now,
    }

    await createDocument(exchange)

    const emailResult = await sendOrganizerLinkCreatedEmail(exchange, rawOrganizerToken)
    if (!emailResult.success) {
      // Email failure is non-fatal — the token is returned in the response.
      trackEvent(context, 'V2OrganizerLinkEmailFailed', { requestId, exchangeId: id, error: emailResult.error || '' })
    }

    trackEvent(context, 'V2ExchangeCreated', { requestId, exchangeId: id, code })

    return {
      status: 201,
      jsonBody: {
        exchange: { ...exchange, organizerTokenHash: undefined },
        organizerToken: rawOrganizerToken,
      },
    }
  } catch (error) {
    trackError(context, error, { requestId, function: 'v2/createExchange' })
    if (error instanceof SyntaxError) {
      return validationErrorResponse('Invalid JSON body', requestId)
    }
    return internalErrorResponse('Failed to create exchange', requestId)
  }
}

app.http('v2CreateExchange', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges',
  handler: createExchangeHandler,
})

// Suppress unused-warning for shared error helpers we re-export
void ApiErrorCode
void createErrorResponse
void getHttpStatusForError
