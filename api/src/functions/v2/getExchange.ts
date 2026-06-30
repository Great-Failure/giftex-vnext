import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest, requireOrganizer } from '../../shared/v2/auth'
import {
  listInvitesByExchange,
  listMatchesByExchange,
  listParticipantsByExchange,
  listWishlistItemsByExchange,
} from '../../shared/v2/cosmosdb'
import { authErrorResponse, forbiddenResponse, internalErrorResponse } from '../../shared/v2/http'

export async function getExchangeHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const exchangeId = request.params.exchangeId

  try {
    const principal = await authenticateRequest(request, context)
    const organizer = requireOrganizer(principal)

    if (organizer.exchange.id !== exchangeId) {
      return forbiddenResponse('Organizer token does not match the requested exchange', requestId)
    }

    const [invites, participants, wishlistItems, matches] = await Promise.all([
      listInvitesByExchange(exchangeId),
      listParticipantsByExchange(exchangeId),
      listWishlistItemsByExchange(exchangeId),
      listMatchesByExchange(exchangeId),
    ])

    trackEvent(context, 'V2ExchangeFetched', { requestId, exchangeId })

    return {
      status: 200,
      jsonBody: {
        exchange: { ...organizer.exchange, organizerTokenHash: undefined },
        counts: {
          invites: invites.length,
          acceptedInvites: invites.filter((i) => i.status === 'accepted').length,
          participants: participants.length,
          wishlistItems: wishlistItems.length,
          matches: matches.length,
        },
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return authErrorResponse(error, requestId)
    }
    trackError(context, error, { requestId, function: 'v2/getExchange', exchangeId })
    return internalErrorResponse('Failed to fetch exchange', requestId)
  }
}

app.http('v2GetExchange', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}',
  handler: getExchangeHandler,
})
