import type { ApiError, RuntimeErrorCode } from '@clawee/protocol';
import { httpFailureMessage } from '@clawee/protocol';

export function apiError(
  code: RuntimeErrorCode,
  message: string,
  details?: Record<string, unknown>
): ApiError {
  const upstreamMessage = typeof details?.upstreamMessage === 'string'
    ? details.upstreamMessage.trim()
    : '';
  return {
    error: {
      code,
      message: code.startsWith('ENTERPRISE_') && details
        ? upstreamMessage || httpFailureMessage(details) || message
        : message,
      ...(details !== undefined ? { details } : {})
    }
  };
}
