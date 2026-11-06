import { net } from 'electron';

export function desktopFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return net.fetch(input.toString(), {
    ...init,
    credentials: 'omit',
    cache: 'no-store'
  });
}
