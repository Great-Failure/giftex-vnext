import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { generateId } from '../../shared/game-utils'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest, generateToken, requireOrganizer } from '../../shared/v2/auth'
import {
  createDocument,
  listInvitesByExchange,
  listParticipantsByExchange,
} from '../../shared/v2/cosmosdb'
import { sendInviteNotification } from '../../shared/v2/notifications'
import { Invite, Language } from '../../shared/v2/types'
import {
  authErrorResponse,
  conflictResponse,
  forbiddenResponse,
  internalErrorResponse,
  validationErrorResponse,
} from '../../shared/v2/http'

const SUPPORTED_LANGUAGES: ReadonlyArray<Language> = ['en', 'es', 'pt', 'fr', 'it', 'ja', 'zh', 'de', 'nl']
const DEFAULT_MAX_PARTICIPANTS = 50

interface InvitePayload {
  email: string
  suggestedName?: string
  preferredLanguage?: Language
}

interface CreateInvitesPayload {
  invites: InvitePayload[]
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export async function createInvitesHandler(
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

    // Invite creation is allowed in 'published' (normal) or 'matching' (late-join).
    const status = organizer.exchange.status
    if (status !== 'published' && status !== 'matching') {
      return conflictResponse(
        `Cannot create invites while exchange status is '${status}' (must be 'published' or 'matching')`,
        requestId,
      )
    }

    const body = (await request.json()) as CreateInvitesPayload
    if (!body.invites || !Array.isArray(body.invites) || body.invites.length === 0) {
      return validationErrorResponse('Request must include a non-empty `invites` array', requestId)
    }

    // Validate every invite up-front so we either create all or none.
    const seenEmails = new Set<string>()
    for (const inv of body.invites) {
      if (!inv.email || typeof inv.email !== 'string' || !isValidEmail(inv.email)) {
        return validationErrorResponse(`Invalid invite email: ${String(inv.email)}`, requestId)
      }
      const normalized = inv.email.trim().toLowerCase()
      if (seenEmails.has(normalized)) {
        return validationErrorResponse(`Duplicate email in request: ${inv.email}`, requestId)
      }
      seenEmails.add(normalized)
      if (inv.preferredLanguage && !SUPPORTED_LANGUAGES.includes(inv.preferredLanguage)) {
        return validationErrorResponse(`Unsupported language: ${inv.preferredLanguage}`, requestId)
      }
    }

    // Enforce maxParticipants. Count = existing accepted participants + all
    // non-declined invites + new invites being added.
    const [existingInvites, existingParticipants] = await Promise.all([
      listInvitesByExchange(exchangeId),
      listParticipantsByExchange(exchangeId),
    ])

    const maxParticipants = organizer.exchange.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS
    const activeInvites = existingInvites.filter((i) => i.status === 'sent' || i.status === 'accepted')
    const activeEmails = new Set(activeInvites.map((i) => i.email.toLowerCase()))

    for (const inv of body.invites) {
      if (activeEmails.has(inv.email.trim().toLowerCase())) {
        return conflictResponse(`An active invite already exists for ${inv.email}`, requestId)
      }
    }

    const projectedCount = existingParticipants.length + activeInvites.length + body.invites.length
    if (projectedCount > maxParticipants) {
      return conflictResponse(
        `Adding ${body.invites.length} invites would exceed maxParticipants (${maxParticipants}); current=${
          existingParticipants.length + activeInvites.length
        }`,
        requestId,
      )
    }

    const isLateJoin = status === 'matching'
    const now = new Date().toISOString()
    const created: Invite[] = []
    const tokensByInviteId: Record<string, string> = {}

    for (const inv of body.invites) {
      const id = generateId()
      const { token: rawInviteToken, tokenHash: inviteTokenHash } = generateToken(exchangeId)

      const invite: Invite = {
        id,
        exchangeId,
        entityType: 'invite',
        inviteTokenHash,
        email: inv.email.trim(),
        suggestedName: inv.suggestedName?.trim(),
        preferredLanguage: inv.preferredLanguage,
        status: 'sent',
        sentAt: now,
        requiresApproval: isLateJoin || undefined,
        createdAt: now,
        updatedAt: now,
      }

      const saved = await createDocument(invite)
      created.push(saved)
      tokensByInviteId[id] = rawInviteToken

      try {
        await sendInviteNotification(context, organizer.exchange, saved, rawInviteToken)
      } catch {
        trackEvent(context, 'V2InviteEmailFailed', { requestId, inviteId: id, error: 'notification_failed' })
      }
    }

    trackEvent(context, 'V2InvitesCreated', {
      requestId,
      exchangeId,
      count: String(created.length),
      lateJoin: String(isLateJoin),
    })

    return {
      status: 201,
      jsonBody: {
        invites: created.map((i) => ({ ...i, inviteTokenHash: undefined })),
        // Raw tokens are returned for testing / out-of-band delivery; production
        // flows should rely on email delivery (#12 will tighten this surface).
        tokens: tokensByInviteId,
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof SyntaxError) return validationErrorResponse('Invalid JSON body', requestId)
    trackError(context, error, { requestId, function: 'v2/createInvites', exchangeId })
    return internalErrorResponse('Failed to create invites', requestId)
  }
}

export async function listInvitesHandler(
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

    const invites = await listInvitesByExchange(exchangeId)

    return {
      status: 200,
      jsonBody: {
        invites: invites.map((i) => ({ ...i, inviteTokenHash: undefined })),
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/listInvites', exchangeId })
    return internalErrorResponse('Failed to list invites', requestId)
  }
}

app.http('v2CreateInvites', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/invites',
  handler: createInvitesHandler,
})

app.http('v2ListInvites', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/invites',
  handler: listInvitesHandler,
})
