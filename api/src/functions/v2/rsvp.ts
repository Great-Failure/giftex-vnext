import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { generateId } from '../../shared/game-utils'
import { trackError, trackEvent } from '../../shared/telemetry'
import {
  ApiAuthError,
  authenticateRequest,
  requireParticipantOrOrganizer,
} from '../../shared/v2/auth'
import { createDocument, replaceDocument } from '../../shared/v2/cosmosdb'
import { Invite, Language, Participant, ParticipantProfile } from '../../shared/v2/types'
import {
  authErrorResponse,
  conflictResponse,
  forbiddenResponse,
  internalErrorResponse,
  validationErrorResponse,
} from '../../shared/v2/http'

const SUPPORTED_LANGUAGES: ReadonlyArray<Language> = ['en', 'es', 'pt', 'fr', 'it', 'ja', 'zh', 'de', 'nl']

interface AcceptPayload {
  displayName: string
  preferredLanguage?: Language
  profile?: ParticipantProfile
}

export async function getMyInviteHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId

  try {
    const principal = await authenticateRequest(request, context)
    if (principal.role !== 'participant') {
      return forbiddenResponse('Invite token is required for this endpoint', requestId)
    }

    return {
      status: 200,
      jsonBody: {
        invite: { ...principal.invite, inviteTokenHash: undefined },
        exchange: {
          id: principal.exchange.id,
          code: principal.exchange.code,
          name: principal.exchange.name,
          description: principal.exchange.description,
          exchangeDate: principal.exchange.exchangeDate,
          exchangeTime: principal.exchange.exchangeTime,
          location: principal.exchange.location,
          generalNotes: principal.exchange.generalNotes,
          budget: principal.exchange.budget,
          status: principal.exchange.status,
          rsvpDeadline: principal.exchange.rsvpDeadline,
          wishlistDeadline: principal.exchange.wishlistDeadline,
        },
        participantId: principal.participantId,
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/getMyInvite' })
    return internalErrorResponse('Failed to load invite context', requestId)
  }
}

export async function acceptInviteHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId

  try {
    const principal = await authenticateRequest(request, context)
    if (principal.role !== 'participant') {
      return forbiddenResponse('Invite token is required to accept', requestId)
    }
    const { invite, exchange } = principal

    if (invite.status === 'accepted' && invite.participantId) {
      return conflictResponse('Invite has already been accepted', requestId)
    }
    if (invite.status === 'declined') {
      return conflictResponse('Invite has already been declined; ask the organizer to resend', requestId)
    }
    if (invite.status === 'expired') {
      return conflictResponse('Invite has expired', requestId)
    }

    // Lifecycle gating: only published, or matching+approved.
    if (exchange.status === 'matching') {
      if (!invite.requiresApproval) {
        // Should not happen — invites created in matching always set requiresApproval.
        return conflictResponse('Invite cannot be accepted in current exchange state', requestId)
      }
      if (!invite.approvedAt) {
        return conflictResponse('Late-join invite requires organizer approval before accepting', requestId)
      }
    } else if (exchange.status !== 'published') {
      return conflictResponse(
        `Cannot accept invite while exchange status is '${exchange.status}'`,
        requestId,
      )
    }

    const body = (await request.json()) as AcceptPayload
    if (!body.displayName || typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
      return validationErrorResponse('displayName is required', requestId)
    }
    if (body.preferredLanguage && !SUPPORTED_LANGUAGES.includes(body.preferredLanguage)) {
      return validationErrorResponse(`Unsupported language: ${body.preferredLanguage}`, requestId)
    }

    const now = new Date().toISOString()
    const participantId = generateId()

    const participant: Participant = {
      id: participantId,
      exchangeId: exchange.id,
      entityType: 'participant',
      inviteId: invite.id,
      displayName: body.displayName.trim(),
      email: invite.email,
      preferredLanguage: body.preferredLanguage || invite.preferredLanguage,
      profile: body.profile,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    }

    await createDocument(participant)

    const updatedInvite: Invite = {
      ...invite,
      status: 'accepted',
      respondedAt: now,
      participantId,
    }
    await replaceDocument(updatedInvite)

    trackEvent(context, 'V2InviteAccepted', {
      requestId,
      exchangeId: exchange.id,
      inviteId: invite.id,
      participantId,
    })

    return {
      status: 200,
      jsonBody: {
        participant,
        invite: { ...updatedInvite, inviteTokenHash: undefined },
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof SyntaxError) return validationErrorResponse('Invalid JSON body', requestId)
    trackError(context, error, { requestId, function: 'v2/acceptInvite' })
    return internalErrorResponse('Failed to accept invite', requestId)
  }
}

export async function declineInviteHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId

  try {
    const principal = await authenticateRequest(request, context)
    if (principal.role !== 'participant') {
      return forbiddenResponse('Invite token is required to decline', requestId)
    }
    const { invite } = principal

    if (invite.status === 'accepted') {
      return conflictResponse('Invite was already accepted; ask the organizer to remove you', requestId)
    }
    if (invite.status === 'declined') {
      return conflictResponse('Invite was already declined', requestId)
    }

    const updated: Invite = {
      ...invite,
      status: 'declined',
      respondedAt: new Date().toISOString(),
    }
    const saved = await replaceDocument(updated)

    trackEvent(context, 'V2InviteDeclined', { requestId, inviteId: invite.id })

    return {
      status: 200,
      jsonBody: { invite: { ...saved, inviteTokenHash: undefined } },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/declineInvite' })
    return internalErrorResponse('Failed to decline invite', requestId)
  }
}

// Use a placeholder path parameter `me` so each route is unambiguous.
app.http('v2GetMyInvite', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/invites/me',
  handler: getMyInviteHandler,
})

app.http('v2AcceptInvite', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/invites/me/accept',
  handler: acceptInviteHandler,
})

app.http('v2DeclineInvite', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/invites/me/decline',
  handler: declineInviteHandler,
})
