// Shared fetch helpers for the radar API.
//
// Why retries: the upstream worker occasionally answers without CORS headers
// (observed while a deploy was rolling out), which the browser surfaces as
// `TypeError: Failed to fetch`. That is transient — the same URL succeeds on
// the next attempt — so a short bounded retry recovers it instead of marking
// the station failed for minutes.
//
// Only network-level failures are retried. A well-formed response with
// `ok: false` is a real answer from the API and is returned as-is, so we never
// hammer the worker for a genuinely bad request.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** True for failures that are worth trying again (network / CORS / 5xx). */
function isTransient(e: unknown): boolean {
  if (e instanceof Error) {
    const name = e.name
    if (name === 'AbortError') return false
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(e.message)) return true
    // ofetch surfaces the HTTP status on the error for non-2xx responses.
    const status = (e as { statusCode?: number, status?: number }).statusCode
      ?? (e as { status?: number }).status
    if (typeof status === 'number') return status >= 500
  }
  return false
}

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  signal?: AbortSignal
}

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 * Resolves with the first success; throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  { attempts = 3, baseDelayMs = 400, signal }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    try {
      return await fn(attempt)
    } catch (e) {
      lastError = e
      if (!isTransient(e) || attempt === attempts) throw e
      // 400ms, 800ms, ... small enough to feel instant, long enough to clear a
      // rolling deploy blip.
      await sleep(baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw lastError
}