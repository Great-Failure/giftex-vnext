import type {
  Exchange,
  Invite,
  Match,
  Participant,
  WishlistItem,
  WishlistPriority,
} from './types'

const V2_BASE = `${import.meta.env.VITE_API_URL || '/api'}/v2`

function authHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }

  if (res.status === 204) {
    return {} as T
  }

  return res.json()
}

export async function createExchange(payload: {
  name: string
  description?: string
  exchangeDate: string
  exchangeTime?: string
  location?: string
  generalNotes?: string
  budget?: { currency: string; amountMin?: string; amountMax?: string }
  rsvpDeadline?: string
  wishlistDeadline?: string
  revealAt?: string
  organizerEmail?: string
  organizerLanguage?: string
  maxParticipants?: number
}): Promise<{ exchange: Exchange; organizerToken: string }> {
  const res = await fetch(`${V2_BASE}/exchanges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  return handleResponse(res)
}

export async function getExchange(exchangeId: string, organizerToken: string) {
  const res = await fetch(`${V2_BASE}/exchanges/${exchangeId}`, {
    headers: authHeader(organizerToken),
  })

  return handleResponse<{
    exchange: Exchange
    counts: {
      invites: number
      acceptedInvites: number
      participants: number
      wishlistItems: number
      matches: number
    }
    participants?: Array<{
      id: string
      displayName: string
      wishlistItemCount: number
    }>
  }>(res)
}

export async function patchExchange(
  exchangeId: string,
  organizerToken: string,
  patch: Partial<Exchange>,
) {
  const res = await fetch(`${V2_BASE}/exchanges/${exchangeId}`, {
    method: 'PATCH',
    headers: authHeader(organizerToken),
    body: JSON.stringify(patch),
  })

  return handleResponse<{ exchange: Exchange }>(res)
}

export async function publishExchange(exchangeId: string, organizerToken: string) {
  const res = await fetch(`${V2_BASE}/exchanges/${exchangeId}/publish`, {
    method: 'POST',
    headers: authHeader(organizerToken),
  })

  return handleResponse<{ exchange: Exchange }>(res)
}

export async function createInvites(
  exchangeId: string,
  organizerToken: string,
  invites: Array<{ email: string; suggestedName?: string; preferredLanguage?: string }>,
) {
  const res = await fetch(`${V2_BASE}/exchanges/${exchangeId}/invites`, {
    method: 'POST',
    headers: authHeader(organizerToken),
    body: JSON.stringify({ invites }),
  })

  return handleResponse<{ invites: Invite[]; tokens: Record<string, string> }>(res)
}

export async function listInvites(exchangeId: string, organizerToken: string) {
  const res = await fetch(`${V2_BASE}/exchanges/${exchangeId}/invites`, {
    headers: authHeader(organizerToken),
  })

  return handleResponse<{ invites: Invite[] }>(res)
}

export async function getMyInvite(inviteToken: string) {
  const res = await fetch(`${V2_BASE}/invites/me`, {
    headers: authHeader(inviteToken),
  })

  return handleResponse<{
    invite: Invite
    exchange: Partial<Exchange>
    participantId?: string
  }>(res)
}

export async function acceptInvite(
  inviteToken: string,
  displayName: string,
  preferredLanguage?: string,
) {
  const res = await fetch(`${V2_BASE}/invites/me/accept`, {
    method: 'POST',
    headers: authHeader(inviteToken),
    body: JSON.stringify({ displayName, preferredLanguage }),
  })

  return handleResponse<{ participant: Participant; invite: Invite }>(res)
}

export async function declineInvite(inviteToken: string) {
  const res = await fetch(`${V2_BASE}/invites/me/decline`, {
    method: 'POST',
    headers: authHeader(inviteToken),
  })

  return handleResponse<{ invite: Invite }>(res)
}

export async function getMyWishlist(inviteToken: string) {
  const res = await fetch(`${V2_BASE}/participants/me/wishlist`, {
    headers: authHeader(inviteToken),
  })

  return handleResponse<{ items: WishlistItem[] }>(res)
}

export async function addWishlistItem(
  inviteToken: string,
  item: { title: string; url?: string; notes?: string; priority?: WishlistPriority },
) {
  const res = await fetch(`${V2_BASE}/participants/me/wishlist`, {
    method: 'POST',
    headers: authHeader(inviteToken),
    body: JSON.stringify(item),
  })

  return handleResponse<{ item: WishlistItem }>(res)
}

export async function updateWishlistItem(
  inviteToken: string,
  itemId: string,
  patch: Partial<{
    title: string
    url: string | null
    notes: string | null
    priority: WishlistPriority
  }>,
) {
  const res = await fetch(`${V2_BASE}/wishlist/${itemId}`, {
    method: 'PATCH',
    headers: authHeader(inviteToken),
    body: JSON.stringify(patch),
  })

  return handleResponse<{ item: WishlistItem }>(res)
}

export async function deleteWishlistItem(inviteToken: string, itemId: string) {
  const res = await fetch(`${V2_BASE}/wishlist/${itemId}`, {
    method: 'DELETE',
    headers: authHeader(inviteToken),
  })

  return handleResponse<Record<string, never>>(res)
}

export async function getMyMatch(inviteToken: string) {
  const res = await fetch(`${V2_BASE}/matches/me`, {
    headers: authHeader(inviteToken),
  })

  return handleResponse<{
    revealStatus?: 'pending' | 'revealed'
    revealAt?: string | null
    match: Match
    receiver: Participant
    wishlist: WishlistItem[]
  }>(res)
}
