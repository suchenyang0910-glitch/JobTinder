export const REMOTE_JOB_USER_AGENT =
  'JobTinderBot/1.0 (+https://jobtinder.kh; contact@jobtinder.kh)';

export async function safeHttpFetch(
  url: string,
  opts: {
    method?: 'GET' | 'HEAD';
    timeoutMs?: number;
    accept?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<{
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  contentType: string | null;
  text: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  headers: Record<string, string>;
}> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': REMOTE_JOB_USER_AGENT,
        Accept: opts.accept ?? '*/*',
        ...(opts.extraHeaders ?? {}),
      },
    });
    clearTimeout(t);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const text = opts.method === 'HEAD' ? null : await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url,
      finalUrl: res.url || url,
      contentType: headers['content-type'] ?? null,
      text,
      errorCode: null,
      errorMessage: null,
      headers,
    };
  } catch (err: any) {
    clearTimeout(t);
    const code = err && err.name === 'AbortError' ? 'TIMEOUT' : (err && err.code) || 'FETCH_ERROR';
    const msg = (err && err.message) || String(err);
    return {
      ok: false,
      status: 0,
      url,
      finalUrl: url,
      contentType: null,
      text: null,
      errorCode: code,
      errorMessage: msg,
      headers: {},
    };
  }
}
