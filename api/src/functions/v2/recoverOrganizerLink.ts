import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { ApiErrorCode, createErrorResponse, getHttpStatusForError, trackError, trackEvent } from '../../shared/telemetry'
import { createOrganizerTokenExpiry, generateToken } from '../../shared/v2/auth'
import { queryExchangesByOrganizerEmail, replaceExchange } from '../../shared/v2/cosmosdb'
import { sendOrganizerLinkResentEmail } from '../../shared/v2/email'
import { Language } from '../../shared/v2/types'

interface RecoverOrganizerLinkRequest {
  email?: string
  language?: Language
}

const RATE_LIMIT_MAX_REQUESTS = 5
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

const recoverRateLimit = new Map<string, { count: number; windowStart: number }>()

function getClientIp(request: HttpRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')

  if (!forwardedFor) {
    return 'unknown'
  }

  return forwardedFor.split(',')[0].trim().toLowerCase() || 'unknown'
}

function isRateLimited(clientIp: string, now = Date.now()): boolean {
  const current = recoverRateLimit.get(clientIp)

  if (!current || now - current.windowStart > RATE_LIMIT_WINDOW_MS) {
    recoverRateLimit.set(clientIp, { count: 1, windowStart: now })
    return false
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true
  }

  current.count += 1
  return false
}

function buildOrganizerMagicLink(exchangeCode: string, organizerToken: string): string {
  const appBaseUrl = process.env.APP_BASE_URL || ''

  if (!appBaseUrl) {
    return `?code=${encodeURIComponent(exchangeCode)}&organizer=${encodeURIComponent(organizerToken)}`
  }

  return `${appBaseUrl}?code=${encodeURIComponent(exchangeCode)}&organizer=${encodeURIComponent(organizerToken)}`
}

export function __resetRecoverRateLimitForTests(): void {
  recoverRateLimit.clear()
}

export async function recoverOrganizerLinkHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const clientIp = getClientIp(request)

  if (isRateLimited(clientIp)) {
    return {
      status: 429,
      jsonBody: {
        error: 'Too many recovery attempts. Please retry later.',
      },
    }
  }

  try {
    const body = (await request.json()) as RecoverOrganizerLinkRequest
    const email = body.email?.trim().toLowerCase()
    const language = body.language || 'en'

    if (!email) {
      return {
        status: 202,
        jsonBody: { ok: true },
      }
    }

    const exchanges = await queryExchangesByOrganizerEmail(email)

    for (const exchange of exchanges) {
      if (!exchange.organizerEmail) {
        continue
      }

      const { token, tokenHash } = generateToken(exchange.id)
      const now = new Date().toISOString()

      const updatedExchange = {
        ...exchange,
        organizerTokenHash: tokenHash,
        organizerTokenExpiresAt: createOrganizerTokenExpiry(),
        updatedAt: now,
      }

      await replaceExchange(updatedExchange)

      const magicLink = buildOrganizerMagicLink(exchange.code, token)
      await sendOrganizerLinkResentEmail(updatedExchange, magicLink, language)

      trackEvent(context, 'V2OrganizerLinkRecoveryRequested', {
        requestId,
        exchangeId: exchange.id,
      })
    }

    return {
      status: 202,
      jsonBody: { ok: true },
    }
  } catch (error) {
    trackError(context, error, { requestId, function: 'v2/recoverOrganizerLink' })

    const apiError = createErrorResponse(
      ApiErrorCode.INTERNAL_ERROR,
      'Failed to process organizer link recovery request',
      undefined,
      requestId,
    )

    return {
      status: getHttpStatusForError(ApiErrorCode.INTERNAL_ERROR),
      jsonBody: {
        error: apiError.message,
        requestId,
      },
    }
  }
}

app.http('v2RecoverOrganizerLink', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/by-email/recover',
  handler: recoverOrganizerLinkHandler,
})
