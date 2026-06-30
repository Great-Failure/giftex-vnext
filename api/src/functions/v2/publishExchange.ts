import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest, requireOrganizer } from '../../shared/v2/auth'
import { replaceDocument } from '../../shared/v2/cosmosdb'
import { assertTransition, LifecycleError } from '../../shared/v2/exchange-lifecycle'
import { Exchange } from '../../shared/v2/types'
import {
  authErrorResponse,
  forbiddenResponse,
  internalErrorResponse,
  lifecycleErrorResponse,
} from '../../shared/v2/http'

export async function publishExchangeHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const exchangeId = request.params.exchangeId

  try {
    const principal = await authenticateRequest(request, context)
    const organizer = requireOrganizer(principal)

    if (organizer.exchange.id !== exchangeId) {
      return forbiddenResponse('Organizer token does not match the requested exchange', requestId)
    }

    assertTransition(organizer.exchange.status, 'published')

    const updated: Exchange = {
      ...organizer.exchange,
      status: 'published',
      publishedAt: new Date().toISOString(),
    }
    const saved = await replaceDocument(updated)

    trackEvent(context, 'V2ExchangePublished', { requestId, exchangeId })

    return {
      status: 200,
      jsonBody: { exchange: { ...saved, organizerTokenHash: undefined } },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof LifecycleError) return lifecycleErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/publishExchange', exchangeId })
    return internalErrorResponse('Failed to publish exchange', requestId)
  }
}

app.http('v2PublishExchange', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/publish',
  handler: publishExchangeHandler,
})
