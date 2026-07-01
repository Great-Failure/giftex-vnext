import { app, InvocationContext, Timer } from '@azure/functions'
import { trackError, trackEvent } from '../../shared/telemetry'
import {
  findExchangesDueForReveal,
  listMatchesByExchange,
  listParticipantsByExchange,
  replaceDocument,
} from '../../shared/v2/cosmosdb'
import { sendMatchRevealNotification } from '../../shared/v2/notifications'

/**
 * Timer trigger — every 15 minutes. Finds Exchanges in status 'matched' whose
 * revealAt has passed, then for each still-pending Match sends the reveal
 * email and atomically marks the Match revealed.
 *
 * Idempotent — Matches already in 'revealed' state (e.g. via pull-on-open)
 * are skipped without re-emailing.
 */
export async function revealMatchesHandler(_timer: Timer, context: InvocationContext): Promise<void> {
  const requestId = context.invocationId
  context.log(`⏰ reveal-matches timer triggered [requestId: ${requestId}]`)

  try {
    const now = new Date()
    const exchanges = await findExchangesDueForReveal(now)

    if (exchanges.length === 0) {
      trackEvent(context, 'V2RevealTimerNoDue', { requestId })
      return
    }

    trackEvent(context, 'V2RevealTimerStart', {
      requestId,
      exchangeCount: String(exchanges.length),
    })

    let totalRevealed = 0
    let totalSkipped = 0
    let totalEmailFailed = 0

    for (const exchange of exchanges) {
      const matches = await listMatchesByExchange(exchange.id)
      const pending = matches.filter((m) => m.revealStatus === 'pending')
      if (pending.length === 0) {
        totalSkipped += matches.length
        continue
      }

      const participants = await listParticipantsByExchange(exchange.id)

      for (const m of pending) {
        const giver = participants.find((p) => p.id === m.giverParticipantId)
        const receiver = participants.find((p) => p.id === m.receiverParticipantId)
        if (!giver || !receiver) {
          trackEvent(context, 'V2RevealTimerOrphanMatch', {
            requestId,
            exchangeId: exchange.id,
            matchId: m.id,
          })
          continue
        }

        // We only store hashed invite tokens at rest, so timer-based reveal
        // emails are skipped until we have a safe way to issue fresh links.
        try {
          await sendMatchRevealNotification(context, exchange, giver, receiver, '')
        } catch (error) {
          totalEmailFailed += 1
          trackEvent(context, 'V2RevealEmailFailed', {
            requestId,
            exchangeId: exchange.id,
            matchId: m.id,
            error: error instanceof Error ? error.message : 'notification_failed',
          })
          continue
        }

        await replaceDocument({
          ...m,
          revealStatus: 'revealed',
          revealedAt: now.toISOString(),
        })
        totalRevealed += 1
      }
    }

    trackEvent(context, 'V2RevealTimerComplete', {
      requestId,
      revealed: String(totalRevealed),
      skipped: String(totalSkipped),
      emailFailed: String(totalEmailFailed),
    })
  } catch (error) {
    trackError(context, error, { requestId, function: 'v2/revealMatches' })
  }
}

app.timer('v2RevealMatches', {
  // Every 15 minutes.
  schedule: '0 */15 * * * *',
  handler: revealMatchesHandler,
  runOnStartup: false,
})
