export const DEVELOPMENT_WEB_PORT = 19_860;
export const DEVELOPMENT_WEB_ORIGIN =
  `http://127.0.0.1:${DEVELOPMENT_WEB_PORT}`;

export function isDevelopmentWebUrl(url: URL): boolean {
  return url.protocol === 'http:'
    && url.hostname === '127.0.0.1'
    && url.port === String(DEVELOPMENT_WEB_PORT);
}
