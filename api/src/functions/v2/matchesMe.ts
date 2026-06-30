import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest } from '../../shared/v2/auth'
import {
  getMatchByGiver,
  listParticipantsByExchange,
  listWishlistItemsByParticipant,
  replaceDocument,
} from '../../shared/v2/cosmosdb'
import {
  authErrorResponse,
  conflictResponse,
  forbiddenResponse,
  internalErrorResponse,
  notFoundResponse,
} from '../../shared/v2/http'

/**
 * GET /api/v2/matches/me
 *
 * Pull-on-open reveal endpoint. Resolves the participant's Match, and if
 * the scheduled reveal time has passed (or is unset), atomically transitions
 * `revealStatus: 'pending' → 'revealed'` and returns the receiver context.
 * Before the reveal window, returns `{ revealStatus: 'pending', revealAt }`
 * with no receiver fields.
 *
 * Idempotent: subsequent calls after reveal return the same payload.
 */
export async function getMyMatchHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId

  try {
    const principal = await authenticateRequest(request, context)
    if (principal.role !== 'participant') {
      return forbiddenResponse('Invite token is required', requestId)
    }
    if (!principal.participantId) {
      return forbiddenResponse('Invite must be accepted before viewing match', requestId)
    }
    if (principal.exchange.status !== 'matched' && principal.exchange.status !== 'completed') {
      return conflictResponse(
        `No match yet — exchange status is '${principal.exchange.status}'`,
        requestId,
      )
    }

    const match = await getMatchByGiver(principal.exchange.id, principal.participantId)
    if (!match) {
      return notFoundResponse('No match found for this participant', requestId)
    }

    // Determine reveal eligibility.
    const now = Date.now()
    const revealAt = principal.exchange.revealAt
      ? Date.parse(principal.exchange.revealAt)
      : principal.exchange.matchedAt
        ? Date.parse(principal.exchange.matchedAt)
        : now
    const eligible = !Number.isNaN(revealAt) && now >= revealAt

    if (match.revealStatus === 'pending' && !eligible) {
      return {
        status: 200,
        jsonBody: {
          revealStatus: 'pending' as const,
          revealAt: principal.exchange.revealAt || principal.exchange.matchedAt || null,
        },
      }
    }

    // Reveal-on-pull: persist the reveal if it hasn't already been done.
    let revealedMatch = match
    if (match.revealStatus === 'pending' && eligible) {
      revealedMatch = await replaceDocument({
        ...match,
        revealStatus: 'revealed',
        revealedAt: new Date().toISOString(),
      })
      trackEvent(context, 'V2MatchRevealedByPull', {
        requestId,
        exchangeId: principal.exchange.id,
        matchId: match.id,
      })
    }

    // Load receiver context.
    const participants = await listParticipantsByExchange(principal.exchange.id)
    const receiver = participants.find((p) => p.id === revealedMatch.receiverParticipantId)
    if (!receiver) {
      return internalErrorResponse('Match references a missing participant', requestId)
    }
    const wishlist = await listWishlistItemsByParticipant(
      principal.exchange.id,
      revealedMatch.receiverParticipantId,
    )

    return {
      status: 200,
      jsonBody: {
        revealStatus: revealedMatch.revealStatus,
        revealedAt: revealedMatch.revealedAt,
        match: {
          id: revealedMatch.id,
          giverParticipantId: revealedMatch.giverParticipantId,
          receiverParticipantId: revealedMatch.receiverParticipantId,
        },
        receiver: {
          id: receiver.id,
          displayName: receiver.displayName,
          profile: receiver.profile,
        },
        wishlist,
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/getMyMatch' })
    return internalErrorResponse('Failed to load match', requestId)
  }
}

app.http('v2GetMyMatch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/matches/me',
  handler: getMyMatchHandler,
})
