import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { ApiErrorCode, createErrorResponse, getHttpStatusForError, trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest } from '../../shared/v2/auth'

export async function meHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const requestId = context.invocationId

  try {
    const principal = await authenticateRequest(request, context)

    if (principal.role === 'public') {
      return {
        status: 200,
        jsonBody: {
          role: 'public',
        },
      }
    }

    const responseBody = {
      role: principal.role,
      exchangeId: principal.exchangeId,
      principalId: principal.role === 'organizer' ? principal.exchange.id : principal.invite.id,
      exchangeName: principal.exchange.name,
      tokenExpiresAt: principal.role === 'organizer' ? principal.exchange.organizerTokenExpiresAt : undefined,
      participantId: principal.role === 'participant' ? principal.participantId : undefined,
    }

    trackEvent(context, 'V2MeAuthenticated', {
      requestId,
      role: principal.role,
      exchangeId: principal.exchangeId,
    })

    return {
      status: 200,
      jsonBody: responseBody,
    }
  } catch (error) {
    if (error instanceof ApiAuthError) {
      const apiError = createErrorResponse(ApiErrorCode.UNAUTHORIZED, error.message, error.code, requestId)

      return {
        status: error.status,
        jsonBody: {
          error: apiError.message,
          code: error.code,
          requestId,
        },
      }
    }

    trackError(context, error, { requestId, function: 'v2/me' })

    const apiError = createErrorResponse(
      ApiErrorCode.INTERNAL_ERROR,
      'Failed to resolve authenticated principal',
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

app.http('v2Me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/me',
  handler: meHandler,
})
