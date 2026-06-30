import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest, generateToken, requireOrganizer } from '../../shared/v2/auth'
import { listInvitesByExchange, replaceDocument } from '../../shared/v2/cosmosdb'
import { sendInviteNotification } from '../../shared/v2/notifications'
import { Invite } from '../../shared/v2/types'
import {
  authErrorResponse,
  conflictResponse,
  forbiddenResponse,
  internalErrorResponse,
  notFoundResponse,
} from '../../shared/v2/http'

export async function resendInviteHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const exchangeId = request.params.exchangeId
  const inviteId = request.params.inviteId

  try {
    const principal = await authenticateRequest(request, context)
    const organizer = requireOrganizer(principal)

    if (organizer.exchange.id !== exchangeId) {
      return forbiddenResponse('Organizer token does not match the requested exchange', requestId)
    }

    const all = await listInvitesByExchange(exchangeId)
    const invite = all.find((i) => i.id === inviteId)
    if (!invite) {
      return notFoundResponse(`Invite '${inviteId}' not found`, requestId)
    }

    if (invite.status === 'accepted' || invite.status === 'declined') {
      return conflictResponse(`Cannot resend a '${invite.status}' invite`, requestId)
    }

    // Rotate token on resend so the previous link is invalidated. This is
    // safer than returning the original token and protects against the old
    // link being intercepted between sends. The plan calls this idempotent on
    // lastResentAt only; rotating the token is a stronger interpretation that
    // matches PR #21's recovery-endpoint behavior.
    const { token: rawInviteToken, tokenHash } = generateToken(exchangeId)
    const updated: Invite = {
      ...invite,
      inviteTokenHash: tokenHash,
      lastResentAt: new Date().toISOString(),
    }
    const saved = await replaceDocument(updated)

    try {
      await sendInviteNotification(context, organizer.exchange, saved, rawInviteToken)
    } catch {
      trackEvent(context, 'V2InviteResendEmailFailed', { requestId, inviteId, error: 'notification_failed' })
    }

    trackEvent(context, 'V2InviteResent', { requestId, exchangeId, inviteId })

    return {
      status: 200,
      jsonBody: {
        invite: { ...saved, inviteTokenHash: undefined },
        token: rawInviteToken,
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/resendInvite', exchangeId, inviteId })
    return internalErrorResponse('Failed to resend invite', requestId)
  }
}

export async function approveInviteHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const exchangeId = request.params.exchangeId
  const inviteId = request.params.inviteId

  try {
    const principal = await authenticateRequest(request, context)
    const organizer = requireOrganizer(principal)

    if (organizer.exchange.id !== exchangeId) {
      return forbiddenResponse('Organizer token does not match the requested exchange', requestId)
    }

    if (organizer.exchange.status !== 'matching') {
      return conflictResponse(
        `Late-join approval is only valid while exchange status is 'matching' (current: '${organizer.exchange.status}')`,
        requestId,
      )
    }

    const all = await listInvitesByExchange(exchangeId)
    const invite = all.find((i) => i.id === inviteId)
    if (!invite) {
      return notFoundResponse(`Invite '${inviteId}' not found`, requestId)
    }

    if (!invite.requiresApproval) {
      return conflictResponse('This invite does not require approval', requestId)
    }
    if (invite.approvedAt) {
      return conflictResponse('This invite is already approved', requestId)
    }

    const updated: Invite = {
      ...invite,
      approvedAt: new Date().toISOString(),
    }
    const saved = await replaceDocument(updated)

    trackEvent(context, 'V2InviteApproved', { requestId, exchangeId, inviteId })

    return {
      status: 200,
      jsonBody: { invite: { ...saved, inviteTokenHash: undefined } },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/approveInvite', exchangeId, inviteId })
    return internalErrorResponse('Failed to approve invite', requestId)
  }
}

app.http('v2ResendInvite', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/invites/{inviteId}/resend',
  handler: resendInviteHandler,
})

app.http('v2ApproveInvite', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/invites/{inviteId}/approve',
  handler: approveInviteHandler,
})
