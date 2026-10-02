// HTTP client for the IMD paid-request API. The bearer token identifies our
// orders; it is generated per run, masked, and never printed.
import { randomBytes } from 'node:crypto';
import { registerSecret } from './gha.js';

export const DEFAULT_API_URL = 'https://api.imd.fun';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    readonly path: string,
  ) {
    super(describeError(status, body, path));
  }
}

function describeError(status: number, body: any, path: string): string {
  const parts = [`${path} returned ${status}`];
  if (body && typeof body === 'object') {
    if (body.error) parts.push(String(body.error));
    if (body.reason) parts.push(`reason: ${body.reason}`);
    if (body.detail) parts.push(String(body.detail).slice(0, 500));
    if (Array.isArray(body.problems) && body.problems.length) {
      const problems = body.problems.slice(0, 10).map((p: any) => {
        const where = p?.path ?? p?.field ?? p?.node ?? '';
        const what = p?.message ?? p?.detail ?? p?.code ?? JSON.stringify(p);
        return `  - ${where ? `${where}: ` : ''}${String(what).slice(0, 300)}`;
      });
      parts.push(`problems:\n${problems.join('\n')}`);
    }
  }
  return parts.join(' | ');
}

export function newBearerToken(): string {
  return randomBytes(32).toString('hex');
}

/** Only https, except plain http to the local machine (the test mock server). */
export function checkApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('api-url is not a valid URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('api-url must use https');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ImdApi {
  readonly token: string;

  constructor(
    readonly baseUrl: string,
    token: string = newBearerToken(),
  ) {
    this.token = token;
    registerSecret(token, { mask: true });
  }

  /** One request; returns any status without throwing. Retries 429/503 and network errors. */
  async raw<T = any>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (opts.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        let body: any = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = { error: 'non_json_response', detail: text.slice(0, 200) };
        }
        if ((res.status === 429 || res.status === 503) && attempt < 3) {
          const after = Number(res.headers.get('retry-after'));
          await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * attempt, 30_000));
          continue;
        }
        return { status: res.status, body: body as T };
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(1000 * attempt);
      }
    }
    throw new Error(`${method} ${path} failed: ${(lastError as Error)?.message ?? 'network error'}`);
  }

  async json<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, ok: number[] = [200, 201]): Promise<T> {
    const res = await this.raw<T>(method, path, { body });
    if (!ok.includes(res.status)) throw new ApiError(res.status, res.body, path);
    return res.body;
  }
}
