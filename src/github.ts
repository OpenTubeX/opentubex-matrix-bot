import { type Fetch, HttpError } from './http'
import type { IssueSummary } from './text'

export interface Issue {
  number: number
  html_url: string
}

export interface IssueUpdate {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  state_reason?: 'completed' | 'not_planned'
}

const encoder = new TextEncoder()

function base64url(data: string | Uint8Array) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function appJwt(appId: string, pem: string) {
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error('GITHUB_APP_PRIVATE_KEY must be PKCS#8: convert it with openssl pkcs8 -topk8 -nocrypt')
  }
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), character => character.charCodeAt(0))
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  const key = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign'])
  const now = Math.floor(Date.now() / 1000)
  // Backdated against clock drift; GitHub rejects lifetimes over ten minutes.
  const claims = { iat: now - 60, exp: now + 540, iss: appId }
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign(algorithm, key, encoder.encode(unsigned))
  return `${unsigned}.${base64url(new Uint8Array(signature))}`
}

export class GitHub {
  private token?: { value: string; expires: number }

  constructor(
    private appId: string,
    private privateKey: string,
    readonly repository: string,
    private http: Fetch,
  ) {}

  private async call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const response = await this.http(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'opentubex-matrix-bot',
        'x-github-api-version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new HttpError('GitHub', method, path, response)
    if (response.status === 204) return undefined as T
    return (response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text()) as T
  }

  private async installationToken() {
    if (this.token && this.token.expires - Date.now() > 5 * 60_000) return this.token.value
    const jwt = await appJwt(this.appId, this.privateKey)
    const installation = await this.call<{ id: number }>('GET', `/repos/${this.repository}/installation`, jwt)
    const token = await this.call<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${installation.id}/access_tokens`,
      jwt,
      { repositories: [this.repository.split('/')[1]] },
    )
    this.token = { value: token.token, expires: Date.parse(token.expires_at) }
    return token.token
  }

  private async request<T>(method: string, path: string, body?: unknown) {
    return this.call<T>(method, path, await this.installationToken(), body)
  }

  createIssue(issue: { title: string; body: string; type: string }) {
    return this.request<Issue>('POST', `/repos/${this.repository}/issues`, issue)
  }

  // Undefined for numbers that are not issues or pull requests here, or were deleted.
  async getIssue(issue: number) {
    try {
      return await this.request<IssueSummary>('GET', `/repos/${this.repository}/issues/${issue}`)
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 410)) return undefined
      throw error
    }
  }

  async updateIssue(issue: number, update: IssueUpdate) {
    await this.request('PATCH', `/repos/${this.repository}/issues/${issue}`, update)
  }

  async comment(issue: number, body: string) {
    return (await this.request<{ id: number }>('POST', `/repos/${this.repository}/issues/${issue}/comments`, { body })).id
  }

  async editComment(comment: number, body: string) {
    await this.request('PATCH', `/repos/${this.repository}/issues/comments/${comment}`, { body })
  }

  async deleteComment(comment: number) {
    await this.request('DELETE', `/repos/${this.repository}/issues/comments/${comment}`)
  }

  // GitHub renders its own Markdown, so references and mentions link like they do on the issue.
  render(text: string) {
    return this.request<string>('POST', '/markdown', { text, mode: 'gfm', context: this.repository })
  }
}
