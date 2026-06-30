import crypto from 'crypto'
import { HttpRequest, InvocationContext } from '@azure/functions'
import { Exchange, Invite } from './types'
import { getExchangeById, queryExchangeByOrganizerTokenHash, queryInviteByTokenHash } from './cosmosdb'

const DEFAULT_ORGANIZER_TOKEN_TTL_DAYS = 90
const TOKEN_SEPARATOR = '.'

export enum ApiAuthErrorCode {
  TOKEN_MISSING = 'token_missing',
  TOKEN_MALFORMED = 'token_malformed',
  TOKEN_INVALID = 'token_invalid',
  TOKEN_EXPIRED = 'token_expired',
  EXCHANGE_NOT_FOUND = 'exchange_not_found',
}

export class ApiAuthError extends Error {
  constructor(
    public readonly code: ApiAuthErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface OrganizerPrincipal {
  role: 'organizer'
  exchange: Exchange
  exchangeId: string
}

export interface ParticipantPrincipal {
  role: 'participant'
  exchange: Exchange
  exchangeId: string
  invite: Invite
  participantId?: string
}

export interface PublicPrincipal {
  role: 'public'
}

export type AuthPrincipal = OrganizerPrincipal | ParticipantPrincipal | PublicPrincipal

function parseTtlDays(): number {
  const rawValue = process.env.AUTH_ORGANIZER_TOKEN_TTL_DAYS

  if (!rawValue) {
    return DEFAULT_ORGANIZER_TOKEN_TTL_DAYS
  }

  const parsed = Number(rawValue)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ORGANIZER_TOKEN_TTL_DAYS
  }

  return Math.floor(parsed)
}

export function getOrganizerTokenTtlDays(): number {
  return parseTtlDays()
}

export function createOrganizerTokenExpiry(now = new Date()): string {
  const expiresAt = new Date(now)
  expiresAt.setUTCDate(expiresAt.getUTCDate() + parseTtlDays())

  return expiresAt.toISOString()
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

export function splitToken(rawToken: string): { exchangeId: string; secret: string } | null {
  if (!rawToken || typeof rawToken !== 'string') {
    return null
  }

  const separatorIndex = rawToken.indexOf(TOKEN_SEPARATOR)

  if (separatorIndex <= 0 || separatorIndex === rawToken.length - 1) {
    return null
  }

  const exchangeId = rawToken.slice(0, separatorIndex)
  const secret = rawToken.slice(separatorIndex + 1)

  if (!exchangeId || !secret) {
    return null
  }

  return { exchangeId, secret }
}

export function generateToken(exchangeId: string): { token: string; tokenHash: string } {
  // 18 bytes => 144 bits entropy, exceeding the 128-bit minimum for unguessable tokens.
  const secret = crypto.randomBytes(18).toString('base64url')
  const token = `${exchangeId}${TOKEN_SEPARATOR}${secret}`

  return {
    token,
    tokenHash: hashToken(token),
  }
}

function extractOrganizerToken(request: HttpRequest): string | null {
  return request.query.get('organizerToken') || request.headers.get('x-organizer-token')
}

function extractInviteToken(request: HttpRequest): string | null {
  return request.query.get('inviteToken') || request.headers.get('x-invite-token')
}

function isExpired(expiresAtIso?: string): boolean {
  if (!expiresAtIso) {
    return false
  }

  const expiry = Date.parse(expiresAtIso)

  if (Number.isNaN(expiry)) {
    return false
  }

  return expiry < Date.now()
}

function assertTokenHashMatch(candidateTokenHash: string, expectedTokenHash: string): void {
  const left = Buffer.from(candidateTokenHash, 'utf8')
  const right = Buffer.from(expectedTokenHash, 'utf8')

  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_INVALID, 403, 'Invalid authentication token')
  }
}

async function authenticateOrganizer(request: HttpRequest): Promise<OrganizerPrincipal> {
  const organizerToken = extractOrganizerToken(request)

  if (!organizerToken) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_MISSING, 401, 'Organizer token is required')
  }

  const split = splitToken(organizerToken)
  if (!split) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_MALFORMED, 401, 'Organizer token format is invalid')
  }

  const organizerTokenHash = hashToken(organizerToken)
  const exchange = await queryExchangeByOrganizerTokenHash(split.exchangeId, organizerTokenHash)

  if (!exchange) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_INVALID, 403, 'Invalid organizer token')
  }

  assertTokenHashMatch(organizerTokenHash, exchange.organizerTokenHash)

  if (isExpired(exchange.organizerTokenExpiresAt)) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_EXPIRED, 401, 'Organizer token has expired')
  }

  return {
    role: 'organizer',
    exchange,
    exchangeId: exchange.id,
  }
}

async function authenticateParticipant(request: HttpRequest): Promise<ParticipantPrincipal> {
  const inviteToken = extractInviteToken(request)

  if (!inviteToken) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_MISSING, 401, 'Invite token is required')
  }

  const split = splitToken(inviteToken)
  if (!split) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_MALFORMED, 401, 'Invite token format is invalid')
  }

  const inviteTokenHash = hashToken(inviteToken)
  const invite = await queryInviteByTokenHash(split.exchangeId, inviteTokenHash)

  if (!invite) {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_INVALID, 403, 'Invalid invite token')
  }

  assertTokenHashMatch(inviteTokenHash, invite.inviteTokenHash)

  const exchange = await getExchangeById(invite.exchangeId)

  if (!exchange) {
    throw new ApiAuthError(ApiAuthErrorCode.EXCHANGE_NOT_FOUND, 404, 'Exchange not found')
  }

  return {
    role: 'participant',
    exchange,
    exchangeId: exchange.id,
    invite,
    participantId: invite.participantId,
  }
}

export async function authenticateRequest(request: HttpRequest, _context: InvocationContext): Promise<AuthPrincipal> {
  const organizerToken = extractOrganizerToken(request)
  if (organizerToken) {
    return authenticateOrganizer(request)
  }

  const inviteToken = extractInviteToken(request)
  if (inviteToken) {
    return authenticateParticipant(request)
  }

  return { role: 'public' }
}

export function requireOrganizer(principal: AuthPrincipal): OrganizerPrincipal {
  if (principal.role !== 'organizer') {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_MISSING, 401, 'Organizer authentication required')
  }

  return principal
}

export function requireParticipantOrOrganizer(principal: AuthPrincipal): OrganizerPrincipal | ParticipantPrincipal {
  if (principal.role === 'public') {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_MISSING, 401, 'Authentication required')
  }

  return principal
}

export function requirePublic(principal: AuthPrincipal): PublicPrincipal {
  if (principal.role !== 'public') {
    throw new ApiAuthError(ApiAuthErrorCode.TOKEN_INVALID, 403, 'Authenticated access is not allowed for this endpoint')
  }

  return principal
}
