/**
 * Shared HTTP response helpers for v2 endpoints. Keeps `try/catch` blocks
 * compact and consistent across the v2 surface.
 */
import { HttpResponseInit } from '@azure/functions'
import { ApiAuthError } from './auth'
import { LifecycleError } from './exchange-lifecycle'
import { ApiErrorCode, createErrorResponse, getHttpStatusForError } from '../telemetry'

export function authErrorResponse(error: ApiAuthError, requestId: string): HttpResponseInit {
  return {
    status: error.status,
    jsonBody: {
      error: error.message,
      code: error.code,
      requestId,
    },
  }
}

export function lifecycleErrorResponse(error: LifecycleError, requestId: string): HttpResponseInit {
  const code = error.code === 'INVALID_TRANSITION' ? ApiErrorCode.CONFLICT : ApiErrorCode.VALIDATION_ERROR
  return {
    status: getHttpStatusForError(code),
    jsonBody: {
      error: error.message,
      code: error.code,
      requestId,
    },
  }
}

export function validationErrorResponse(message: string, requestId: string, details?: string): HttpResponseInit {
  const apiError = createErrorResponse(ApiErrorCode.VALIDATION_ERROR, message, details, requestId)
  return {
    status: getHttpStatusForError(ApiErrorCode.VALIDATION_ERROR),
    jsonBody: { error: apiError.message, details: apiError.details, requestId },
  }
}

export function notFoundResponse(message: string, requestId: string): HttpResponseInit {
  const apiError = createErrorResponse(ApiErrorCode.NOT_FOUND, message, undefined, requestId)
  return {
    status: getHttpStatusForError(ApiErrorCode.NOT_FOUND),
    jsonBody: { error: apiError.message, requestId },
  }
}

export function conflictResponse(message: string, requestId: string): HttpResponseInit {
  const apiError = createErrorResponse(ApiErrorCode.CONFLICT, message, undefined, requestId)
  return {
    status: getHttpStatusForError(ApiErrorCode.CONFLICT),
    jsonBody: { error: apiError.message, requestId },
  }
}

export function forbiddenResponse(message: string, requestId: string): HttpResponseInit {
  const apiError = createErrorResponse(ApiErrorCode.FORBIDDEN, message, undefined, requestId)
  return {
    status: getHttpStatusForError(ApiErrorCode.FORBIDDEN),
    jsonBody: { error: apiError.message, requestId },
  }
}

export function internalErrorResponse(message: string, requestId: string): HttpResponseInit {
  return {
    status: getHttpStatusForError(ApiErrorCode.INTERNAL_ERROR),
    jsonBody: { error: message, requestId },
  }
}
