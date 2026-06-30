/**
 * Zava Gift Exchange API - Azure Functions Entry Point
 * This file imports all function handlers to register them with the runtime
 */

import { initializeStorage } from './shared/cosmosdb'
import { initializeEmailService } from './shared/email-service'
import { initializeTelemetry } from './shared/telemetry'
import { initializeV2Container } from './shared/v2/cosmosdb'

// Initialize all services
;(async () => {
  // Initialize telemetry first to capture any errors during startup
  initializeTelemetry()
  
  // Initialize database connection
  await initializeStorage()
  
  // Initialize optional email service
  initializeEmailService()

  // Initialize v2 exchanges container
  await initializeV2Container()
})().catch(err => {
  console.error('Failed to initialize services:', err)
})

// Import all function handlers
import './functions/health'
import './functions/createGame'
import './functions/getGame'
import './functions/updateGame'
import './functions/deleteGame'
import './functions/sendEmail'
import './functions/cleanupExpiredGames'
import './functions/v2/me'
import './functions/v2/recoverOrganizerLink'
import './functions/v2/createExchange'
import './functions/v2/getExchangeByCode'
import './functions/v2/getExchange'
import './functions/v2/patchExchange'
import './functions/v2/publishExchange'
import './functions/v2/cancelExchange'
import './functions/v2/invites'
import './functions/v2/inviteAdmin'
import './functions/v2/rsvp'
import './functions/v2/wishlist'
import './functions/v2/match'
import './functions/v2/matchesMe'
import './functions/v2/revealMatches'
