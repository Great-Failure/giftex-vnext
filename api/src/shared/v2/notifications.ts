import crypto from 'crypto'
import { InvocationContext } from '@azure/functions'

import { sendEmail } from '../email-service'
import { generateId } from '../game-utils'
import { trackError, trackEvent } from '../telemetry'
import { createDocument, queryNotificationByIdempotencyKey } from './cosmosdb'
import { Exchange, Invite, Language, NotificationEvent, NotificationType, Participant } from './types'

function appBaseUrl(): string {
  return process.env.APP_BASE_URL?.replace(/\/$/, '') || ''
}

function isEmailConfigured(): boolean {
  return Boolean(process.env.ACS_CONNECTION_STRING && process.env.ACS_SENDER_ADDRESS)
}

export function generateUnsubscribeToken(recipientEmail: string): string {
  const secret = process.env.UNSUBSCRIBE_HMAC_SECRET
  if (!secret) {
    if (process.env.ENVIRONMENT === 'prod') {
      throw new Error('UNSUBSCRIBE_HMAC_SECRET must be configured in production')
    }
    return crypto.createHmac('sha256', 'dev-secret-change-me').update(recipientEmail.toLowerCase()).digest('base64url')
  }
  return crypto.createHmac('sha256', secret).update(recipientEmail.toLowerCase()).digest('base64url')
}

export function isUnsubscribeTokenValid(token: string, recipientEmail: string): boolean {
  const expected = generateUnsubscribeToken(recipientEmail)
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

export function buildUnsubscribeUrl(recipientEmail: string): string {
  const token = generateUnsubscribeToken(recipientEmail)
  return `${appBaseUrl()}/api/v2/unsubscribe?email=${encodeURIComponent(recipientEmail)}&token=${encodeURIComponent(token)}`
}

function buildIdempotencyKey(
  type: NotificationType,
  exchangeId: string,
  recipientRefId: string,
  extraSuffix?: string,
): string {
  const base = `${exchangeId}:${type}:${recipientRefId}`
  return extraSuffix ? `${base}:${extraSuffix}` : base
}

async function notificationAlreadySent(
  exchangeId: string,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    const existing = await queryNotificationByIdempotencyKey(exchangeId, idempotencyKey)
    return existing !== null
  } catch {
    return false
  }
}

async function recordNotification(
  exchangeId: string,
  type: NotificationType,
  recipientKind: NotificationEvent['recipientKind'],
  recipientRefId: string,
  recipientEmail: string,
  idempotencyKey: string,
  providerMessageId?: string,
): Promise<void> {
  const now = new Date().toISOString()
  const notification: NotificationEvent = {
    id: generateId(),
    exchangeId,
    entityType: 'notificationEvent',
    type,
    recipientKind,
    recipientRefId,
    recipientEmail,
    status: 'sent',
    sentAt: now,
    providerMessageId,
    idempotencyKey,
    createdAt: now,
    updatedAt: now,
  }
  await createDocument(notification)
}

interface EmailContent { subject: string; html: string; plainText: string }

function inviteSentTemplate(exchange: Exchange, invite: Invite, rsvpLink: string, lang: Language): EmailContent {
  const name = invite.suggestedName || invite.email
  switch (lang) {
    case 'es': return {
      subject: `Estás invitado/a a "${exchange.name}"`,
      html: `<p>Hola ${name},</p><p>Estás invitado/a al intercambio de regalos "<strong>${exchange.name}</strong>" el ${exchange.exchangeDate}.</p><p><a href="${rsvpLink}">Acepta o declina la invitación</a></p>`,
      plainText: `Estás invitado/a a "${exchange.name}" el ${exchange.exchangeDate}. RSVP: ${rsvpLink}`,
    }
    case 'pt': return {
      subject: `Você foi convidado para "${exchange.name}"`,
      html: `<p>Olá ${name},</p><p>Você foi convidado para a troca de presentes "<strong>${exchange.name}</strong>" em ${exchange.exchangeDate}.</p><p><a href="${rsvpLink}">Aceitar ou recusar o convite</a></p>`,
      plainText: `Você foi convidado para "${exchange.name}" em ${exchange.exchangeDate}. RSVP: ${rsvpLink}`,
    }
    case 'fr': return {
      subject: `Vous êtes invité à "${exchange.name}"`,
      html: `<p>Bonjour ${name},</p><p>Vous êtes invité à l'échange de cadeaux "<strong>${exchange.name}</strong>" le ${exchange.exchangeDate}.</p><p><a href="${rsvpLink}">Accepter ou refuser l'invitation</a></p>`,
      plainText: `Vous êtes invité à "${exchange.name}" le ${exchange.exchangeDate}. RSVP: ${rsvpLink}`,
    }
    case 'it': return {
      subject: `Sei invitato a "${exchange.name}"`,
      html: `<p>Ciao ${name},</p><p>Sei invitato allo scambio di regali "<strong>${exchange.name}</strong>" il ${exchange.exchangeDate}.</p><p><a href="${rsvpLink}">Accetta o rifiuta l'invito</a></p>`,
      plainText: `Sei invitato a "${exchange.name}" il ${exchange.exchangeDate}. RSVP: ${rsvpLink}`,
    }
    case 'ja': return {
      subject: `「${exchange.name}」にご招待します`,
      html: `<p>${name}様、</p><p>${exchange.exchangeDate}に開催される「<strong>${exchange.name}</strong>」のギフト交換にご招待します。</p><p><a href="${rsvpLink}">招待を承諾または辞退する</a></p>`,
      plainText: `「${exchange.name}」にご招待します（${exchange.exchangeDate}）。RSVP: ${rsvpLink}`,
    }
    case 'zh': return {
      subject: `您被邀请参加“${exchange.name}”`,
      html: `<p>你好 ${name}，</p><p>您被邀请参加${exchange.exchangeDate}的礼物交换“<strong>${exchange.name}</strong>”。</p><p><a href="${rsvpLink}">接受或拒绝邀请</a></p>`,
      plainText: `您被邀请参加“${exchange.name}”（${exchange.exchangeDate}）。RSVP: ${rsvpLink}`,
    }
    case 'de': return {
      subject: `Sie sind eingeladen zu "${exchange.name}"`,
      html: `<p>Hallo ${name},</p><p>Sie sind zum Geschenkeaustausch "<strong>${exchange.name}</strong>" am ${exchange.exchangeDate} eingeladen.</p><p><a href="${rsvpLink}">Einladung annehmen oder ablehnen</a></p>`,
      plainText: `Sie sind eingeladen zu "${exchange.name}" am ${exchange.exchangeDate}. RSVP: ${rsvpLink}`,
    }
    case 'nl': return {
      subject: `U bent uitgenodigd voor "${exchange.name}"`,
      html: `<p>Hallo ${name},</p><p>U bent uitgenodigd voor de cadeau-uitwisseling "<strong>${exchange.name}</strong>" op ${exchange.exchangeDate}.</p><p><a href="${rsvpLink}">Uitnodiging accepteren of weigeren</a></p>`,
      plainText: `U bent uitgenodigd voor "${exchange.name}" op ${exchange.exchangeDate}. RSVP: ${rsvpLink}`,
    }
    default: return {
      subject: `You're invited to "${exchange.name}"`,
      html: `<p>Hi ${name},</p><p>You're invited to the gift exchange "<strong>${exchange.name}</strong>" on ${exchange.exchangeDate}.</p><p><a href="${rsvpLink}">Accept or decline your invitation</a></p>`,
      plainText: `You're invited to "${exchange.name}" on ${exchange.exchangeDate}. RSVP: ${rsvpLink}`,
    }
  }
}

function rsvpAcceptedTemplate(exchange: Exchange, participant: Participant, wishlistLink: string, lang: Language): EmailContent {
  const name = participant.displayName
  switch (lang) {
    case 'es': return {
      subject: `¡Confirmado! Eres parte de "${exchange.name}"`,
      html: `<p>Hola ${name},</p><p>Tu participación en "<strong>${exchange.name}</strong>" está confirmada.</p><p><a href="${wishlistLink}">Añade artículos a tu lista de deseos</a></p>`,
      plainText: `Confirmado: participas en "${exchange.name}". Lista de deseos: ${wishlistLink}`,
    }
    default: return {
      subject: `Confirmed! You're joining "${exchange.name}"`,
      html: `<p>Hi ${name},</p><p>Your participation in "<strong>${exchange.name}</strong>" is confirmed.</p><p><a href="${wishlistLink}">Add items to your wishlist</a></p>`,
      plainText: `Confirmed: you're joining "${exchange.name}". Wishlist: ${wishlistLink}`,
    }
  }
}

function wishlistReminderTemplate(exchange: Exchange, participant: Participant, wishlistLink: string, unsubscribeUrl: string, lang: Language): EmailContent {
  const name = participant.displayName
  switch (lang) {
    case 'es': return {
      subject: 'Recordatorio: añade artículos a tu lista de deseos',
      html: `<p>Hola ${name},</p><p>El plazo para añadir artículos a tu lista de deseos en "<strong>${exchange.name}</strong>" se acerca.</p><p><a href="${wishlistLink}">Ver mi lista de deseos</a></p><p style="font-size:12px;color:#888;">Si no quieres más recordatorios, <a href="${unsubscribeUrl}">cancela la suscripción</a>.</p>`,
      plainText: `Recordatorio de lista de deseos para "${exchange.name}". Lista: ${wishlistLink}\nCancelar: ${unsubscribeUrl}`,
    }
    default: return {
      subject: 'Reminder: add items to your wishlist',
      html: `<p>Hi ${name},</p><p>The wishlist deadline for "<strong>${exchange.name}</strong>" is coming up.</p><p><a href="${wishlistLink}">View my wishlist</a></p><p style="font-size:12px;color:#888;">Don't want reminders? <a href="${unsubscribeUrl}">Unsubscribe</a>.</p>`,
      plainText: `Wishlist reminder for "${exchange.name}". Wishlist: ${wishlistLink}\nUnsubscribe: ${unsubscribeUrl}`,
    }
  }
}

function matchRevealTemplate(exchange: Exchange, giver: Participant, receiver: Participant, matchLink: string, lang: Language): EmailContent {
  switch (lang) {
    case 'es': return {
      subject: `¡Los emparejamientos están listos para "${exchange.name}"!`,
      html: `<p>Hola ${giver.displayName},</p><p>¡Ya están los emparejamientos para "<strong>${exchange.name}</strong>"!</p><p>Tu regalo es para <strong>${receiver.displayName}</strong>.</p><p><a href="${matchLink}">Ver la lista de deseos</a></p>`,
      plainText: `Emparejamiento para "${exchange.name}": regala a ${receiver.displayName}. Detalles: ${matchLink}`,
    }
    default: return {
      subject: `Matches are out for "${exchange.name}"!`,
      html: `<p>Hi ${giver.displayName},</p><p>The matches are out for "<strong>${exchange.name}</strong>"!</p><p>You'll be giving a gift to <strong>${receiver.displayName}</strong>.</p><p><a href="${matchLink}">View their wishlist</a></p>`,
      plainText: `Match reveal for "${exchange.name}": you give to ${receiver.displayName}. Details: ${matchLink}`,
    }
  }
}

function giftByReminderTemplate(exchange: Exchange, participant: Participant, matchLink: string, unsubscribeUrl: string, lang: Language): EmailContent {
  switch (lang) {
    case 'es': return {
      subject: 'Recordatorio: el día del regalo se acerca',
      html: `<p>Hola ${participant.displayName},</p><p>El intercambio de regalos "<strong>${exchange.name}</strong>" es el ${exchange.exchangeDate}. ¡No olvides tu regalo!</p><p><a href="${matchLink}">Ver los detalles</a></p><p style="font-size:12px;color:#888;"><a href="${unsubscribeUrl}">Cancelar suscripción</a></p>`,
      plainText: `Recordatorio: "${exchange.name}" es el ${exchange.exchangeDate}. Detalles: ${matchLink}\nCancelar: ${unsubscribeUrl}`,
    }
    default: return {
      subject: 'Reminder: gift exchange day is coming up',
      html: `<p>Hi ${participant.displayName},</p><p>The gift exchange "<strong>${exchange.name}</strong>" is on ${exchange.exchangeDate}. Don't forget your gift!</p><p><a href="${matchLink}">View details</a></p><p style="font-size:12px;color:#888;"><a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
      plainText: `Reminder: "${exchange.name}" is on ${exchange.exchangeDate}. Details: ${matchLink}\nUnsubscribe: ${unsubscribeUrl}`,
    }
  }
}

export async function sendInviteNotification(
  context: InvocationContext,
  exchange: Exchange,
  invite: Invite,
  rawInviteToken: string,
): Promise<void> {
  if (!isEmailConfigured()) return

  const resendSuffix = invite.lastResentAt || invite.sentAt
  const idempotencyKey = buildIdempotencyKey('inviteSent', exchange.id, invite.id, resendSuffix)
  if (await notificationAlreadySent(exchange.id, idempotencyKey)) return

  const rsvpLink = `${appBaseUrl()}/rsvp?token=${encodeURIComponent(rawInviteToken)}`
  const lang: Language = invite.preferredLanguage || exchange.organizerLanguage || 'en'
  const { subject, html, plainText } = inviteSentTemplate(exchange, invite, rsvpLink, lang)

  const result = await sendEmail({ to: [{ address: invite.email }], subject, html, plainText })
  if (result.success) {
    await recordNotification(exchange.id, 'inviteSent', 'invite', invite.id, invite.email, idempotencyKey, result.messageId)
    trackEvent(context, 'V2NotificationSent', { type: 'inviteSent', exchangeId: exchange.id, inviteId: invite.id })
  } else {
    trackError(context, new Error(result.error || 'Email send failed'), { type: 'inviteSent', exchangeId: exchange.id })
  }
}

export async function sendRsvpAcceptedNotification(
  context: InvocationContext,
  exchange: Exchange,
  participant: Participant,
  rawInviteToken: string,
): Promise<void> {
  if (!isEmailConfigured()) return

  const idempotencyKey = buildIdempotencyKey('rsvpAccepted', exchange.id, participant.id)
  if (await notificationAlreadySent(exchange.id, idempotencyKey)) return

  const wishlistLink = `${appBaseUrl()}/wishlist?token=${encodeURIComponent(rawInviteToken)}`
  const lang: Language = participant.preferredLanguage || exchange.organizerLanguage || 'en'
  const { subject, html, plainText } = rsvpAcceptedTemplate(exchange, participant, wishlistLink, lang)

  const result = await sendEmail({ to: [{ address: participant.email }], subject, html, plainText })
  if (result.success) {
    await recordNotification(exchange.id, 'rsvpAccepted', 'participant', participant.id, participant.email, idempotencyKey, result.messageId)
  }
}

export async function sendMatchRevealNotification(
  context: InvocationContext,
  exchange: Exchange,
  giver: Participant,
  receiver: Participant,
  rawInviteToken: string,
): Promise<void> {
  if (!isEmailConfigured()) return

  const idempotencyKey = buildIdempotencyKey('matchReveal', exchange.id, giver.id)
  if (await notificationAlreadySent(exchange.id, idempotencyKey)) return

  const matchLink = `${appBaseUrl()}/match?token=${encodeURIComponent(rawInviteToken)}`
  const lang: Language = giver.preferredLanguage || exchange.organizerLanguage || 'en'
  const { subject, html, plainText } = matchRevealTemplate(exchange, giver, receiver, matchLink, lang)

  const result = await sendEmail({ to: [{ address: giver.email }], subject, html, plainText })
  if (result.success) {
    await recordNotification(exchange.id, 'matchReveal', 'participant', giver.id, giver.email, idempotencyKey, result.messageId)
  }
}

export async function sendWishlistReminderNotification(
  context: InvocationContext,
  exchange: Exchange,
  participant: Participant,
  rawInviteToken: string,
): Promise<void> {
  if (!isEmailConfigured()) return

  const idempotencyKey = buildIdempotencyKey('wishlistReminder', exchange.id, participant.id)
  if (await notificationAlreadySent(exchange.id, idempotencyKey)) return

  const wishlistLink = `${appBaseUrl()}/wishlist?token=${encodeURIComponent(rawInviteToken)}`
  const unsubUrl = buildUnsubscribeUrl(participant.email)
  const lang: Language = participant.preferredLanguage || exchange.organizerLanguage || 'en'
  const { subject, html, plainText } = wishlistReminderTemplate(exchange, participant, wishlistLink, unsubUrl, lang)

  const result = await sendEmail({ to: [{ address: participant.email }], subject, html, plainText })
  if (result.success) {
    await recordNotification(exchange.id, 'wishlistReminder', 'participant', participant.id, participant.email, idempotencyKey, result.messageId)
  }
}

export async function sendGiftByReminderNotification(
  context: InvocationContext,
  exchange: Exchange,
  participant: Participant,
  rawInviteToken: string,
): Promise<void> {
  if (!isEmailConfigured()) return

  const idempotencyKey = buildIdempotencyKey('giftByReminder', exchange.id, participant.id)
  if (await notificationAlreadySent(exchange.id, idempotencyKey)) return

  const matchLink = `${appBaseUrl()}/match?token=${encodeURIComponent(rawInviteToken)}`
  const unsubUrl = buildUnsubscribeUrl(participant.email)
  const lang: Language = participant.preferredLanguage || exchange.organizerLanguage || 'en'
  const { subject, html, plainText } = giftByReminderTemplate(exchange, participant, matchLink, unsubUrl, lang)

  const result = await sendEmail({ to: [{ address: participant.email }], subject, html, plainText })
  if (result.success) {
    await recordNotification(exchange.id, 'giftByReminder', 'participant', participant.id, participant.email, idempotencyKey, result.messageId)
  }
}

