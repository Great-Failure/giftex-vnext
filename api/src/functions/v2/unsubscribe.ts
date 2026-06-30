import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'

import { trackEvent } from '../../shared/telemetry'
import { validationErrorResponse } from '../../shared/v2/http'
import { isUnsubscribeTokenValid } from '../../shared/v2/notifications'

export async function handleUnsubscribe(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const email = request.query.get('email') || ''
  const token = request.query.get('token') || ''

  if (!email || !token) {
    return validationErrorResponse('email and token are required', requestId)
  }

  if (!isUnsubscribeTokenValid(token, email)) {
    return validationErrorResponse('Invalid unsubscribe token', requestId)
  }

  trackEvent(context, 'V2Unsubscribed', { requestId, email: `${email.substring(0, 3)}***` })
  return {
    status: 200,
    jsonBody: { message: 'You have been unsubscribed from non-critical notifications.' },
  }
}

app.http('v2Unsubscribe', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'v2/unsubscribe',
  handler: handleUnsubscribe,
})
