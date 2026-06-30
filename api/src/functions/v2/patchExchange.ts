import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { validateDateString } from '../../shared/game-utils'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest, requireOrganizer } from '../../shared/v2/auth'
import { replaceDocument } from '../../shared/v2/cosmosdb'
import { assertPatchAllowed, LifecycleError } from '../../shared/v2/exchange-lifecycle'
import { Exchange } from '../../shared/v2/types'
import {
  authErrorResponse,
  forbiddenResponse,
  internalErrorResponse,
  lifecycleErrorResponse,
  validationErrorResponse,
} from '../../shared/v2/http'

export async function patchExchangeHandler(
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

    const patch = (await request.json()) as Partial<Exchange>

    // Field-level gating per lifecycle status.
    assertPatchAllowed(organizer.exchange.status, patch)

    // Per-field validation for fields actually present in the patch.
    if (patch.exchangeDate !== undefined) {
      if (typeof patch.exchangeDate !== 'string') {
        return validationErrorResponse('exchangeDate must be a YYYY-MM-DD string', requestId)
      }
      const v = validateDateString(patch.exchangeDate)
      if (!v.valid) return validationErrorResponse(v.error, requestId)
    }

    if (patch.maxParticipants !== undefined) {
      if (
        !Number.isInteger(patch.maxParticipants) ||
        patch.maxParticipants < 3 ||
        patch.maxParticipants > 50
      ) {
        return validationErrorResponse('maxParticipants must be an integer between 3 and 50', requestId)
      }
    }

    if (patch.revealAt !== undefined && patch.revealAt !== null) {
      if (typeof patch.revealAt !== 'string' || Number.isNaN(Date.parse(patch.revealAt))) {
        return validationErrorResponse('revealAt must be an ISO 8601 timestamp', requestId)
      }
    }

    const updated: Exchange = {
      ...organizer.exchange,
      ...patch,
      // Carry through immutable fields no matter what the caller sent.
      id: organizer.exchange.id,
      exchangeId: organizer.exchange.exchangeId,
      entityType: 'exchange',
      code: organizer.exchange.code,
      status: organizer.exchange.status,
      organizerTokenHash: organizer.exchange.organizerTokenHash,
      organizerTokenExpiresAt: organizer.exchange.organizerTokenExpiresAt,
      createdAt: organizer.exchange.createdAt,
    }

    const saved = await replaceDocument(updated)

    trackEvent(context, 'V2ExchangeUpdated', {
      requestId,
      exchangeId,
      fields: Object.keys(patch).join(','),
    })

    return {
      status: 200,
      jsonBody: { exchange: { ...saved, organizerTokenHash: undefined } },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof LifecycleError) return lifecycleErrorResponse(error, requestId)
    if (error instanceof SyntaxError) return validationErrorResponse('Invalid JSON body', requestId)
    trackError(context, error, { requestId, function: 'v2/patchExchange', exchangeId })
    return internalErrorResponse('Failed to update exchange', requestId)
  }
}

app.http('v2PatchExchange', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}',
  handler: patchExchangeHandler,
})
