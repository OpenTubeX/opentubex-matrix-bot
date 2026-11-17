export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class HttpError extends Error {
  readonly status: number
  readonly retry: boolean

  constructor(service: string, method: string, path: string, response: Response) {
    // Paths and status codes only: bodies and query strings can hold tokens or user content.
    super(`${service} ${method} ${path.replace(/\?.*/, '')} failed with ${response.status}`)
    const status = (this.status = response.status)
    const rateLimited = response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
    // Rejected credentials are retried until they are fixed, so no message is lost. Other 4xx
    // responses (locked or deleted issues, invalid input) would fail forever and are skipped.
    this.retry = status === 401 || status === 408 || status === 429 || status >= 500 || (status === 403 && rateLimited)
  }
}

export function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
