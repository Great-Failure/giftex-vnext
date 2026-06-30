import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { trackError, trackEvent } from '../../shared/telemetry'
import { getExchangeByCode } from '../../shared/v2/cosmosdb'
import { internalErrorResponse, notFoundResponse, validationErrorResponse } from '../../shared/v2/http'

export async function getExchangeByCodeHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const requestId = context.invocationId
  const code = request.params.code

  try {
    if (!code || !/^\d{6}$/.test(code)) {
      return validationErrorResponse('Exchange code must be a 6-digit string', requestId)
    }

    const exchange = await getExchangeByCode(code)
    if (!exchange || exchange.status === 'cancelled') {
      return notFoundResponse(`No exchange found for code '${code}'`, requestId)
    }

    trackEvent(context, 'V2ExchangeLookupByCode', { requestId, code, status: exchange.status })

    return {
      status: 200,
      jsonBody: {
        id: exchange.id,
        code: exchange.code,
        name: exchange.name,
        status: exchange.status,
        exchangeDate: exchange.exchangeDate,
      },
    }
  } catch (error) {
    trackError(context, error, { requestId, function: 'v2/getExchangeByCode', code })
    return internalErrorResponse('Failed to look up exchange', requestId)
  }
}

app.http('v2GetExchangeByCode', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v2/exchanges/by-code/{code}',
  handler: getExchangeByCodeHandler,
})
