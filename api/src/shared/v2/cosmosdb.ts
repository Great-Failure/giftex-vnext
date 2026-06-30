import { CosmosClient, Container } from '@azure/cosmos'
import { Exchange, ExchangeContainerDocument, Invite, Match, NotificationEvent, Participant, WishlistItem } from './types'

let cosmosClient: CosmosClient | null = null
let v2Container: Container | null = null

const DEFAULT_DB_NAME = 'zavaexchangegift'
const DEFAULT_CONTAINER_NAME = 'exchanges'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} environment variable is not configured`)
  }

  return value
}

export async function initializeV2Container(): Promise<void> {
  if (v2Container) {
    return
  }

  const endpoint = requireEnv('COSMOS_ENDPOINT')
  const key = requireEnv('COSMOS_KEY')

  cosmosClient = new CosmosClient({
    endpoint,
    key,
    connectionPolicy: {
      enableEndpointDiscovery: false,
    },
  })

  const databaseId = process.env.COSMOS_DATABASE_NAME || DEFAULT_DB_NAME
  const containerId = process.env.COSMOS_V2_CONTAINER_NAME || DEFAULT_CONTAINER_NAME

  await cosmosClient.databases.createIfNotExists({ id: databaseId })
  const database = cosmosClient.database(databaseId)

  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: ['/exchangeId'] },
  })

  v2Container = container
}

async function getV2Container(): Promise<Container> {
  if (!v2Container) {
    await initializeV2Container()
  }

  if (!v2Container) {
    throw new Error('v2 exchanges container is not initialized')
  }

  return v2Container
}

export async function getExchangeById(exchangeId: string): Promise<Exchange | null> {
  try {
    const container = await getV2Container()
    const { resource } = await container.item(exchangeId, exchangeId).read<Exchange>()

    if (!resource || resource.entityType !== 'exchange') {
      return null
    }

    return resource
  } catch (error: any) {
    if (error?.code === 404) {
      return null
    }

    throw error
  }
}

export async function replaceExchange(exchange: Exchange): Promise<Exchange> {
  const container = await getV2Container()
  const { resource } = await container.item(exchange.id, exchange.exchangeId).replace<Exchange>(exchange)

  if (!resource) {
    throw new Error('Failed to update exchange document')
  }

  return resource
}

export async function queryExchangeByOrganizerTokenHash(exchangeId: string, organizerTokenHash: string): Promise<Exchange | null> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT TOP 1 * FROM c
      WHERE c.entityType = 'exchange'
        AND c.exchangeId = @exchangeId
        AND c.organizerTokenHash = @organizerTokenHash
    `,
    parameters: [
      { name: '@exchangeId', value: exchangeId },
      { name: '@organizerTokenHash', value: organizerTokenHash },
    ],
  }

  const { resources } = await container.items
    .query<Exchange>(querySpec, { partitionKey: exchangeId })
    .fetchAll()

  return resources[0] || null
}

export async function queryInviteByTokenHash(exchangeId: string, inviteTokenHash: string): Promise<Invite | null> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT TOP 1 * FROM c
      WHERE c.entityType = 'invite'
        AND c.exchangeId = @exchangeId
        AND c.inviteTokenHash = @inviteTokenHash
    `,
    parameters: [
      { name: '@exchangeId', value: exchangeId },
      { name: '@inviteTokenHash', value: inviteTokenHash },
    ],
  }

  const { resources } = await container.items
    .query<Invite>(querySpec, { partitionKey: exchangeId })
    .fetchAll()

  return resources[0] || null
}

export async function queryNotificationByIdempotencyKey(
  exchangeId: string,
  idempotencyKey: string,
): Promise<NotificationEvent | null> {
  const container = await getV2Container()
  const querySpec = {
    query: 'SELECT TOP 1 * FROM c WHERE c.exchangeId = @exchangeId AND c.entityType = @entityType AND c.idempotencyKey = @idempotencyKey',
    parameters: [
      { name: '@exchangeId', value: exchangeId },
      { name: '@entityType', value: 'notificationEvent' },
      { name: '@idempotencyKey', value: idempotencyKey },
    ],
  }
  const { resources } = await container.items.query<NotificationEvent>(querySpec).fetchAll()
  return resources[0] || null
}

export async function queryExchangesByOrganizerEmail(email: string): Promise<Exchange[]> {
  const normalizedEmail = email.trim().toLowerCase()

  if (!normalizedEmail) {
    return []
  }

  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.entityType = 'exchange'
        AND IS_DEFINED(c.organizerEmail)
        AND LOWER(c.organizerEmail) = @organizerEmail
    `,
    parameters: [{ name: '@organizerEmail', value: normalizedEmail }],
  }

  const { resources } = await container.items.query<Exchange>(querySpec).fetchAll()

  return resources
}

export async function queryExchangeByOrganizerEmail(email: string): Promise<Exchange | null> {
  const exchanges = await queryExchangesByOrganizerEmail(email)
  return exchanges[0] || null
}

// ---------------------------------------------------------------------------
// Generic document helpers (#4/#5/#6)
// ---------------------------------------------------------------------------

/**
 * Insert any v2 document. Stamps `createdAt`/`updatedAt` (idempotent — won't
 * overwrite values the caller already set explicitly). Returns the persisted
 * document with server-assigned `_etag` etc.
 */
export async function createDocument<T extends ExchangeContainerDocument>(doc: T): Promise<T> {
  const container = await getV2Container()
  const now = new Date().toISOString()
  const payload = {
    ...doc,
    createdAt: doc.createdAt || now,
    updatedAt: doc.updatedAt || now,
  }

  const { resource } = await container.items.create<T>(payload as T)

  if (!resource) {
    throw new Error('Failed to create document')
  }

  return resource
}

/**
 * Replace any v2 document. Bumps `updatedAt`. Caller is responsible for
 * passing the full current document (this is a full replace, not a patch).
 */
export async function replaceDocument<T extends ExchangeContainerDocument>(doc: T): Promise<T> {
  const container = await getV2Container()
  const payload = {
    ...doc,
    updatedAt: new Date().toISOString(),
  }

  const { resource } = await container.item(doc.id, doc.exchangeId).replace<T>(payload as T)

  if (!resource) {
    throw new Error('Failed to replace document')
  }

  return resource
}

/** Delete a single v2 document by id + partition key. */
export async function deleteDocument(id: string, exchangeId: string): Promise<void> {
  const container = await getV2Container()
  try {
    await container.item(id, exchangeId).delete()
  } catch (error: any) {
    if (error?.code === 404) {
      return
    }
    throw error
  }
}

/**
 * Look up an Exchange by its 6-digit code. Cross-partition query — used only
 * for the public join-by-code flow and for code-uniqueness retry on create.
 */
export async function getExchangeByCode(code: string): Promise<Exchange | null> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT TOP 1 * FROM c
      WHERE c.entityType = 'exchange'
        AND c.code = @code
    `,
    parameters: [{ name: '@code', value: code }],
  }

  const { resources } = await container.items.query<Exchange>(querySpec).fetchAll()

  return resources[0] || null
}

/** List all Invite documents for an Exchange. Single-partition query. */
export async function listInvitesByExchange(exchangeId: string): Promise<Invite[]> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.entityType = 'invite' AND c.exchangeId = @exchangeId
      ORDER BY c.createdAt ASC
    `,
    parameters: [{ name: '@exchangeId', value: exchangeId }],
  }

  const { resources } = await container.items.query<Invite>(querySpec, { partitionKey: exchangeId }).fetchAll()
  return resources
}

/** List all Participant documents for an Exchange. Single-partition query. */
export async function listParticipantsByExchange(exchangeId: string): Promise<Participant[]> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.entityType = 'participant' AND c.exchangeId = @exchangeId
      ORDER BY c.joinedAt ASC
    `,
    parameters: [{ name: '@exchangeId', value: exchangeId }],
  }

  const { resources } = await container.items.query<Participant>(querySpec, { partitionKey: exchangeId }).fetchAll()
  return resources
}

/** List all WishlistItem documents for an Exchange. */
export async function listWishlistItemsByExchange(exchangeId: string): Promise<WishlistItem[]> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.entityType = 'wishlistItem' AND c.exchangeId = @exchangeId
    `,
    parameters: [{ name: '@exchangeId', value: exchangeId }],
  }

  const { resources } = await container.items.query<WishlistItem>(querySpec, { partitionKey: exchangeId }).fetchAll()
  return resources
}

/** List a single participant's wishlist items. */
export async function listWishlistItemsByParticipant(
  exchangeId: string,
  participantId: string,
): Promise<WishlistItem[]> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.entityType = 'wishlistItem'
        AND c.exchangeId = @exchangeId
        AND c.participantId = @participantId
    `,
    parameters: [
      { name: '@exchangeId', value: exchangeId },
      { name: '@participantId', value: participantId },
    ],
  }

  const { resources } = await container.items.query<WishlistItem>(querySpec, { partitionKey: exchangeId }).fetchAll()
  return resources
}

/** List all Match documents for an Exchange. */
export async function listMatchesByExchange(exchangeId: string): Promise<Match[]> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.entityType = 'match' AND c.exchangeId = @exchangeId
    `,
    parameters: [{ name: '@exchangeId', value: exchangeId }],
  }

  const { resources } = await container.items.query<Match>(querySpec, { partitionKey: exchangeId }).fetchAll()
  return resources
}

/** Find the Match where a specific participant is the giver. */
export async function getMatchByGiver(exchangeId: string, giverParticipantId: string): Promise<Match | null> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT TOP 1 * FROM c
      WHERE c.entityType = 'match'
        AND c.exchangeId = @exchangeId
        AND c.giverParticipantId = @giverParticipantId
    `,
    parameters: [
      { name: '@exchangeId', value: exchangeId },
      { name: '@giverParticipantId', value: giverParticipantId },
    ],
  }

  const { resources } = await container.items.query<Match>(querySpec, { partitionKey: exchangeId }).fetchAll()
  return resources[0] || null
}

/**
 * Find Exchanges whose scheduled reveal time has passed and whose status is
 * `matched`. Cross-partition. Used only by the reveal timer trigger.
 */
export async function findExchangesDueForReveal(now: Date): Promise<Exchange[]> {
  const container = await getV2Container()

  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.entityType = 'exchange'
        AND c.status = 'matched'
        AND IS_DEFINED(c.revealAt)
        AND c.revealAt <= @now
    `,
    parameters: [{ name: '@now', value: now.toISOString() }],
  }

  const { resources } = await container.items.query<Exchange>(querySpec).fetchAll()
  return resources
}
