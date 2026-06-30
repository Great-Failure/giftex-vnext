import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { generateId } from '../../shared/game-utils'
import { trackError, trackEvent } from '../../shared/telemetry'
import { ApiAuthError, authenticateRequest } from '../../shared/v2/auth'
import {
  createDocument,
  deleteDocument,
  getExchangeById,
  getMatchByGiver,
  listParticipantsByExchange,
  listWishlistItemsByParticipant,
  replaceDocument,
} from '../../shared/v2/cosmosdb'
import { Container, CosmosClient } from '@azure/cosmos'
import { WishlistItem, WishlistPriority } from '../../shared/v2/types'
import {
  authErrorResponse,
  conflictResponse,
  forbiddenResponse,
  internalErrorResponse,
  notFoundResponse,
  validationErrorResponse,
} from '../../shared/v2/http'

const VALID_PRIORITIES: ReadonlyArray<WishlistPriority> = ['high', 'medium', 'low']

interface CreateWishlistItemPayload {
  title: string
  url?: string
  notes?: string
  priority?: WishlistPriority
}

interface PatchWishlistItemPayload {
  title?: string
  url?: string | null
  notes?: string | null
  priority?: WishlistPriority
}

function isFrozenStatus(status: string): boolean {
  return status === 'matched' || status === 'completed' || status === 'cancelled'
}

// Direct container access for wishlist item lookup by id+partition.
// We don't want to scan listWishlistItemsByExchange every time, and we need
// to validate ownership before allowing any edit.
let _container: Container | null = null
async function getContainer(): Promise<Container> {
  if (_container) return _container
  const client = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT!,
    key: process.env.COSMOS_KEY!,
    connectionPolicy: { enableEndpointDiscovery: false },
  })
  _container = client
    .database(process.env.COSMOS_DATABASE_NAME || 'zavaexchangegift')
    .container(process.env.COSMOS_V2_CONTAINER_NAME || 'exchanges')
  return _container
}

async function readWishlistItem(itemId: string, exchangeId: string): Promise<WishlistItem | null> {
  try {
    const c = await getContainer()
    const { resource } = await c.item(itemId, exchangeId).read<WishlistItem>()
    if (!resource || resource.entityType !== 'wishlistItem') return null
    return resource
  } catch (e: any) {
    if (e?.code === 404) return null
    throw e
  }
}

// ---------------------------------------------------------------------------
// POST /api/v2/participants/me/wishlist  (invite token)
// ---------------------------------------------------------------------------
export async function createWishlistItemHandler(
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
      return conflictResponse('Invite must be accepted before adding wishlist items', requestId)
    }
    if (isFrozenStatus(principal.exchange.status)) {
      return conflictResponse(
        `Wishlist edits are frozen while exchange status is '${principal.exchange.status}'`,
        requestId,
      )
    }

    const body = (await request.json()) as CreateWishlistItemPayload
    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
      return validationErrorResponse('title is required', requestId)
    }
    if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
      return validationErrorResponse(`Invalid priority: ${body.priority}`, requestId)
    }

    const now = new Date().toISOString()
    const item: WishlistItem = {
      id: generateId(),
      exchangeId: principal.exchange.id,
      entityType: 'wishlistItem',
      participantId: principal.participantId,
      title: body.title.trim(),
      url: body.url?.trim() || undefined,
      notes: body.notes?.trim() || undefined,
      priority: body.priority || 'medium',
      createdAt: now,
      updatedAt: now,
    }

    const saved = await createDocument(item)

    trackEvent(context, 'V2WishlistItemCreated', {
      requestId,
      exchangeId: principal.exchange.id,
      participantId: principal.participantId,
      itemId: saved.id,
    })

    return { status: 201, jsonBody: { item: saved } }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof SyntaxError) return validationErrorResponse('Invalid JSON body', requestId)
    trackError(context, error, { requestId, function: 'v2/createWishlistItem' })
    return internalErrorResponse('Failed to create wishlist item', requestId)
  }
}

// ---------------------------------------------------------------------------
// GET /api/v2/participants/me/wishlist  (invite token, own items)
// ---------------------------------------------------------------------------
export async function listMyWishlistHandler(
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
      return { status: 200, jsonBody: { items: [] } }
    }

    const items = await listWishlistItemsByParticipant(principal.exchange.id, principal.participantId)
    return { status: 200, jsonBody: { items } }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/listMyWishlist' })
    return internalErrorResponse('Failed to list wishlist items', requestId)
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/v2/wishlist/{itemId}  (invite token, own item)
// ---------------------------------------------------------------------------
export async function patchWishlistItemHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const itemId = request.params.itemId

  try {
    const principal = await authenticateRequest(request, context)
    if (principal.role !== 'participant') {
      return forbiddenResponse('Invite token is required', requestId)
    }
    if (!principal.participantId) {
      return forbiddenResponse('Invite must be accepted before editing wishlist items', requestId)
    }
    if (isFrozenStatus(principal.exchange.status)) {
      return conflictResponse(
        `Wishlist edits are frozen while exchange status is '${principal.exchange.status}'`,
        requestId,
      )
    }

    const existing = await readWishlistItem(itemId, principal.exchange.id)
    if (!existing) {
      return notFoundResponse(`Wishlist item '${itemId}' not found`, requestId)
    }
    if (existing.participantId !== principal.participantId) {
      return forbiddenResponse('You can only edit your own wishlist items', requestId)
    }

    const body = (await request.json()) as PatchWishlistItemPayload
    if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
      return validationErrorResponse(`Invalid priority: ${body.priority}`, requestId)
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
      return validationErrorResponse('title cannot be empty', requestId)
    }

    const updated: WishlistItem = {
      ...existing,
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.url !== undefined ? { url: body.url ? body.url.trim() : undefined } : {}),
      ...(body.notes !== undefined ? { notes: body.notes ? body.notes.trim() : undefined } : {}),
    }
    const saved = await replaceDocument(updated)

    trackEvent(context, 'V2WishlistItemUpdated', { requestId, itemId })
    return { status: 200, jsonBody: { item: saved } }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    if (error instanceof SyntaxError) return validationErrorResponse('Invalid JSON body', requestId)
    trackError(context, error, { requestId, function: 'v2/patchWishlistItem', itemId })
    return internalErrorResponse('Failed to update wishlist item', requestId)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/v2/wishlist/{itemId}  (invite token, own item)
// ---------------------------------------------------------------------------
export async function deleteWishlistItemHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const itemId = request.params.itemId

  try {
    const principal = await authenticateRequest(request, context)
    if (principal.role !== 'participant') {
      return forbiddenResponse('Invite token is required', requestId)
    }
    if (!principal.participantId) {
      return forbiddenResponse('Invite must be accepted before deleting wishlist items', requestId)
    }
    if (isFrozenStatus(principal.exchange.status)) {
      return conflictResponse(
        `Wishlist edits are frozen while exchange status is '${principal.exchange.status}'`,
        requestId,
      )
    }

    const existing = await readWishlistItem(itemId, principal.exchange.id)
    if (!existing) {
      // Idempotent — already gone.
      return { status: 204 }
    }
    if (existing.participantId !== principal.participantId) {
      return forbiddenResponse('You can only delete your own wishlist items', requestId)
    }

    await deleteDocument(itemId, principal.exchange.id)
    trackEvent(context, 'V2WishlistItemDeleted', { requestId, itemId })
    return { status: 204 }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, { requestId, function: 'v2/deleteWishlistItem', itemId })
    return internalErrorResponse('Failed to delete wishlist item', requestId)
  }
}

// ---------------------------------------------------------------------------
// GET /api/v2/exchanges/{exchangeId}/participants/{participantId}/wishlist
//   Giver view post-reveal. Organizer can always read; participant can only
//   read their assigned receiver's list after their Match is revealed.
// ---------------------------------------------------------------------------
export async function getParticipantWishlistHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const exchangeId = request.params.exchangeId
  const targetParticipantId = request.params.participantId

  try {
    const principal = await authenticateRequest(request, context)
    if (principal.role === 'public') {
      return forbiddenResponse('Authentication required', requestId)
    }
    if (principal.exchange.id !== exchangeId) {
      return forbiddenResponse('Token does not match the requested exchange', requestId)
    }

    if (principal.role === 'participant') {
      if (!principal.participantId) {
        return forbiddenResponse('Invite must be accepted to view a receiver wishlist', requestId)
      }
      // The caller may only see the wishlist of their assigned receiver, and
      // only after their match has been revealed.
      const match = await getMatchByGiver(exchangeId, principal.participantId)
      if (!match || match.receiverParticipantId !== targetParticipantId) {
        return forbiddenResponse('You are not assigned to give a gift to this participant', requestId)
      }
      if (match.revealStatus !== 'revealed') {
        return forbiddenResponse('Match has not been revealed yet', requestId)
      }
    }
    // Organizers may read any participant's list within their own exchange.

    // Verify the target participant actually exists in this exchange.
    const ex = await getExchangeById(exchangeId)
    if (!ex) return notFoundResponse('Exchange not found', requestId)

    const participants = await listParticipantsByExchange(exchangeId)
    const target = participants.find((p) => p.id === targetParticipantId)
    if (!target) {
      return notFoundResponse(`Participant '${targetParticipantId}' not found in this exchange`, requestId)
    }

    const items = await listWishlistItemsByParticipant(exchangeId, targetParticipantId)
    trackEvent(context, 'V2WishlistViewedByGiver', {
      requestId,
      exchangeId,
      viewerRole: principal.role,
      targetParticipantId,
    })

    return {
      status: 200,
      jsonBody: {
        participant: {
          id: target.id,
          displayName: target.displayName,
          profile: target.profile,
        },
        items,
      },
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error, requestId)
    trackError(context, error, {
      requestId,
      function: 'v2/getParticipantWishlist',
      exchangeId,
      targetParticipantId,
    })
    return internalErrorResponse('Failed to load wishlist', requestId)
  }
}

app.http('v2CreateWishlistItem', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v2/participants/me/wishlist',
  handler: createWishlistItemHandler,
})

app.http('v2ListMyWishlist', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/participants/me/wishlist',
  handler: listMyWishlistHandler,
})

app.http('v2PatchWishlistItem', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'v2/wishlist/{itemId}',
  handler: patchWishlistItemHandler,
})

app.http('v2DeleteWishlistItem', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'v2/wishlist/{itemId}',
  handler: deleteWishlistItemHandler,
})

app.http('v2GetParticipantWishlist', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/{exchangeId}/participants/{participantId}/wishlist',
  handler: getParticipantWishlistHandler,
})
