import { CosmosClient, Container } from '@azure/cosmos'
import { Exchange, Invite } from './types'

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
  const containerId = process.env.COSMOS_V2_CONTAINER_NAME || process.env.COSMOS_CONTAINER_NAME || DEFAULT_CONTAINER_NAME

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
