import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest, requireOrganizer } from '../../shared/v2/auth'
import {
  createDocument,
  deleteDocument,
  listInvitesByExchange,
  listMatchesByExchange,
  listParticipantsByExchange,
  replaceDocument,
} from '../../shared/v2/cosmosdb'
import { sendMatchRevealEmail } from '../../shared/v2/email'
import { assertTransition, LifecycleError } from '../../shared/v2/exchange-lifecycle'
import { generateMatches, regenerateMatchesWithLocks } from '../../shared/v2/matching'
import { Exchange, Match, PARTICIPANT_BOUNDS } from '../../shared/v2/types'
import {
  authErrorResponse,
  conflictResponse,
  forbiddenResponse,
  internalErrorResponse,
  lifecycleErrorResponse,
  validationErrorResponse,
} from '../../shared/v2/http'

// ---------------------------------------------------------------------------
// POST /api/v2/exchanges/{exchangeId}/match  (organizer)
// ---------------------------------------------------------------------------
export async function runMatchHandler(
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

    // Must be Published before matching can start.
    assertTransition(organizer.exchange.status, 'matching')

    const participants = await listParticipantsByExchange(exchangeId)
    const maxParticipants = organizer.exchange.maxParticipants ?? PARTICIPANT_BOUNDS.max
    if (participants.length < PARTICIPANT_BOUNDS.min) {
      return validationErrorResponse(
        `Need at least ${PARTICIPANT_BOUNDS.min} accepted participants to match (have ${participants.length})`,
        requestId,
      )
    }
    if (participants.length > maxParticipants) {
      return validationErrorResponse(
        `Cannot match: ${participants.length} participants exceeds maxParticipants (${maxParticipants})`,
        requestId,
      )
    }

    // Wipe any prior Match documents (defensive — should be none on first
    // run but rerunning after a cancelled rematch could leave stragglers).
    const existing = await listMatchesByExchange(exchangeId)
    for (const m of existing) {
      await deleteDocument(m.id, exchangeId)
    }

    // Transition published → matching, persist, then run + write matches.
    const matchingStartedAt = new Date().toISOString()
    let updated: Exchange = {
      ...organizer.exchange,
      status: 'matching',
      matchingStartedAt,
    }
    updated = await replaceDocument(updated)

    const matches = generateMatches(exchangeId, participants)
    for (const m of matches) {
      await createDocument(m)
    }

    // Transition matching → matched.
    const matchedAt = new Date().toISOString()
    updated = {
      ...updated,
      status: 'matched',
      matchedAt,
    }
    updated = await replaceDocument(updated)

    // Immediate reveal: if revealAt is unset or already in the past, send
    // reveal emails now and mark matches revealed. Otherwise the timer will
    // handle it (or pull-on-open via GET /matches/me, whichever happens first).
    const now = new Date()
    const revealNow = !updated.revealAt || Date.parse(updated.revealAt) <= now.getTime()

    if (revealNow) {
      // Build participant + invite lookup so we can dispatch the email.
      const invites = await listInvitesByExchange(exchangeId)
      const inviteById: Record<string, (typeof invites)[number]> = {}
      for (const i of invites) inviteById[i.id] = i

      for (const m of matches) {
        const giver = participants.find((p) => p.id === m.giverParticipantId)!
        const receiver = participants.find((p) => p.id === m.receiverParticipantId)!
        const giverInvite = inviteById[giver.inviteId]
        const rawToken = giverInvite ? `${exchangeId}.<token-rotated>` : ''
        // Note: we don't have the giver's raw invite token at rest (we only
        // store the hash). The reveal email therefore deep-links the user to
        // the generic /match page; in production the giver navigates there
        // with the invite token they already have. For Phase 1 this is the
        // intended behavior; #12 will redesign with proper magic links.
        await sendMatchRevealEmail(updated, giver, receiver, rawToken)
        await replaceDocument({
          ...m,
          revealStatus: 'revealed',
          revealedAt: now.toISOString(),
        })
      }
    }

    trackEvent(context, 'V2ExchangeMatched', {
      requestId,
      exchangeId,
      matchCount: String(matches.length),
      immediateReveal: String(revealNow),
    })

    const finalMatches = revealNow
      ? matches.map((m) => ({ ...m, revealStatus: 'revealed' as const, revealedAt: now.toISOString() }))
      : matches

    return {
      status: 200,
      jsonBody: {
        exchange: { ...updated, organizerTokenHash: undefined },
        matches: finalMatches,
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof LifecycleError) return lifecycleErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/runMatch', exchangeId })
    return internalErrorResponse('Failed to run matching', requestId)
  }
}

// ---------------------------------------------------------------------------
// POST /api/v2/exchanges/{exchangeId}/rematch  (organizer, pre-reveal only)
// ---------------------------------------------------------------------------
export async function rematchHandler(
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

    if (organizer.exchange.status !== 'matched') {
      return conflictResponse(
        `Rematch requires exchange status 'matched' (current: '${organizer.exchange.status}')`,
        requestId,
      )
    }

    const currentMatches = await listMatchesByExchange(exchangeId)
    if (currentMatches.some((m) => m.revealStatus === 'revealed')) {
      return conflictResponse('Cannot rematch after any match has been revealed', requestId)
    }

    const participants = await listParticipantsByExchange(exchangeId)
    const newMatches = regenerateMatchesWithLocks(exchangeId, participants, currentMatches)

    // Replace prior matches with the new set.
    for (const m of currentMatches) {
      await deleteDocument(m.id, exchangeId)
    }
    for (const m of newMatches) {
      await createDocument(m)
    }

    trackEvent(context, 'V2ExchangeRematched', {
      requestId,
      exchangeId,
      matchCount: String(newMatches.length),
    })

    return { status: 200, jsonBody: { matches: newMatches } }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/rematch', exchangeId })
    return internalErrorResponse('Failed to rematch', requestId)
  }
}

// ---------------------------------------------------------------------------
// POST /api/v2/exchanges/{exchangeId}/complete  (organizer)
// ---------------------------------------------------------------------------
export async function completeExchangeHandler(
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

    assertTransition(organizer.exchange.status, 'completed')

    const updated: Exchange = {
      ...organizer.exchange,
      status: 'completed',
      completedAt: new Date().toISOString(),
    }
    const saved = await replaceDocument(updated)

    trackEvent(context, 'V2ExchangeCompleted', { requestId, exchangeId })

    return {
      status: 200,
      jsonBody: { exchange: { ...saved, organizerTokenHash: undefined } },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof LifecycleError) return lifecycleErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/completeExchange', exchangeId })
    return internalErrorResponse('Failed to complete exchange', requestId)
  }
}

// Reference to keep Match import live for downstream consumers.
void {} as unknown as Match

app.http('v2RunMatch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/match',
  handler: runMatchHandler,
})

app.http('v2Rematch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/rematch',
  handler: rematchHandler,
})

app.http('v2CompleteExchange', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/complete',
  handler: completeExchangeHandler,
})
