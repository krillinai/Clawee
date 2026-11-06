export class CustomerUpdateError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function updateErrorCode(error: unknown): string {
  if (error instanceof CustomerUpdateError) return error.code;
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOSPC') return 'INSUFFICIENT_SPACE';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'PERMISSION_DENIED';
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'SIGNATURE_FAILED';
  if (code === 'ERR_UPDATER_CHECKSUM_MISMATCH') return 'PACKAGE_CORRUPT';
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return 'NETWORK_FAILED';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED'].includes(code ?? '')
    || (error instanceof Error && ['TimeoutError', 'FetchError'].includes(error.name))) return 'NETWORK_FAILED';
  if (error instanceof TypeError && error.message === 'fetch failed') return 'NETWORK_FAILED';
  if (error instanceof Error && /net::ERR_(?:CONNECTION_(?:RESET|REFUSED|CLOSED|TIMED_OUT)|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|TIMED_OUT)\b/.test(error.message)) return 'NETWORK_FAILED';
  return 'UPDATE_FAILED';
}
