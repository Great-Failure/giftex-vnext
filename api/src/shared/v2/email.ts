import { Exchange, Invite, Language, Participant } from './types'
import { Game } from '../types'
import { generateOrganizerRecoveryEmailContent, sendEmail } from '../email-service'

function deriveOrganizerToken(magicLink: string): string {
  try {
    const parsed = new URL(magicLink)
    return parsed.searchParams.get('organizer') || ''
  } catch {
    return ''
  }
}

function toGameForRecoveryEmail(exchange: Exchange, organizerToken: string): Game {
  return {
    id: exchange.id,
    code: exchange.code,
    name: exchange.name,
    amount: '',
    currency: exchange.budget?.currency || 'USD',
    date: exchange.exchangeDate,
    time: exchange.exchangeTime,
    location: exchange.location || '',
    allowReassignment: false,
    isProtected: true,
    generalNotes: exchange.generalNotes || '',
    participants: [],
    assignments: [],
    reassignmentRequests: [],
    organizerToken,
    organizerEmail: exchange.organizerEmail,
    organizerLanguage: exchange.organizerLanguage,
    createdAt: Date.parse(exchange.createdAt) || Date.now(),
  }
}

export async function sendOrganizerLinkResentEmail(
  exchange: Exchange,
  magicLink: string,
  language: Language = 'en',
): Promise<{ success: boolean; error?: string }> {
  if (!exchange.organizerEmail) {
    return { success: false, error: 'Organizer email is not configured' }
  }

  const organizerToken = deriveOrganizerToken(magicLink)
  const game = toGameForRecoveryEmail(exchange, organizerToken)
  const { subject, html, plainText } = generateOrganizerRecoveryEmailContent({ game, language })

  return sendEmail({
    to: [{ address: exchange.organizerEmail }],
    subject,
    html,
    plainText,
  })
}

// ---------------------------------------------------------------------------
// Minimal v2 lifecycle emails (#4/#5/#6)
// ---------------------------------------------------------------------------
// Phase 1 keeps these intentionally simple: short inline templates that pass
// through the existing ACS `sendEmail` low-level helper. Full per-language
// templates + idempotency land with issue #12 (NotificationEvent system).
// When ACS is not configured (PR/dev environments), each helper short-circuits
// to `{ success: true, skipped: true }` so endpoints stay testable.

function appBaseUrl(): string {
  return process.env.APP_BASE_URL?.replace(/\/$/, '') || ''
}

function isEmailConfigured(): boolean {
  return Boolean(process.env.ACS_CONNECTION_STRING && process.env.ACS_SENDER_ADDRESS)
}

export async function sendOrganizerLinkCreatedEmail(
  exchange: Exchange,
  rawOrganizerToken: string,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  if (!exchange.organizerEmail) {
    return { success: true, skipped: true }
  }
  if (!isEmailConfigured()) {
    return { success: true, skipped: true }
  }

  const link = `${appBaseUrl()}/organizer?token=${encodeURIComponent(rawOrganizerToken)}`
  const subject = `Your organizer link for "${exchange.name}"`
  const html = `<p>Hi,</p><p>Your gift exchange "<strong>${exchange.name}</strong>" (code <strong>${exchange.code}</strong>) is created.</p><p><a href="${link}">Open the organizer panel</a></p><p>Keep this link safe — it's the only way to manage the exchange.</p>`
  const plainText = `Your gift exchange "${exchange.name}" (code ${exchange.code}) is created. Organizer link: ${link}`

  return sendEmail({
    to: [{ address: exchange.organizerEmail }],
    subject,
    html,
    plainText,
  })
}

export async function sendInviteSentEmail(
  exchange: Exchange,
  invite: Invite,
  rawInviteToken: string,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  if (!isEmailConfigured()) {
    return { success: true, skipped: true }
  }

  const link = `${appBaseUrl()}/rsvp?token=${encodeURIComponent(rawInviteToken)}`
  const name = invite.suggestedName || invite.email
  const subject = `You're invited to "${exchange.name}"`
  const html = `<p>Hi ${name},</p><p>You're invited to the gift exchange "<strong>${exchange.name}</strong>" on ${exchange.exchangeDate}.</p><p><a href="${link}">Accept or decline your invitation</a></p>`
  const plainText = `You're invited to "${exchange.name}" on ${exchange.exchangeDate}. RSVP: ${link}`

  return sendEmail({
    to: [{ address: invite.email }],
    subject,
    html,
    plainText,
  })
}

export async function sendMatchRevealEmail(
  exchange: Exchange,
  giver: Participant,
  receiver: Participant,
  rawInviteToken: string,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  if (!isEmailConfigured()) {
    return { success: true, skipped: true }
  }

  const link = `${appBaseUrl()}/match?token=${encodeURIComponent(rawInviteToken)}`
  const subject = `Your gift exchange match for "${exchange.name}"`
  const html = `<p>Hi ${giver.displayName},</p><p>The matches are out for "<strong>${exchange.name}</strong>"!</p><p>You'll be giving a gift to <strong>${receiver.displayName}</strong>.</p><p><a href="${link}">View their wishlist and details</a></p>`
  const plainText = `Match reveal for "${exchange.name}": you give to ${receiver.displayName}. Details: ${link}`

  return sendEmail({
    to: [{ address: giver.email }],
    subject,
    html,
    plainText,
  })
}
