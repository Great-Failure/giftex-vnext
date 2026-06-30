import { Exchange, Language } from './types'
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
