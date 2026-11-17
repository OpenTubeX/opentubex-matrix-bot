export type GitHubEvent =
  | { kind: 'comment' | 'edit'; issue: number; id: number; body: string; author: string; url: string; delivery: string }
  | { kind: 'delete'; issue: number; id: number; delivery: string }
  | { kind: 'state'; issue: number; state: 'closed' | 'reopened'; reason: string | null; author: string; url: string; delivery: string }

interface Payload {
  action?: string
  repository?: { full_name?: string }
  sender?: { login?: string }
  issue?: { number: number; html_url: string; state_reason?: string | null; pull_request?: unknown }
  comment?: { id: number; body?: string | null; html_url: string; user?: { login?: string } }
}

const encoder = new TextEncoder()

export async function verifySignature(secret: string, body: string, header: string | null) {
  const hex = header?.match(/^sha256=([\da-f]{64})$/)?.[1]
  if (!hex || !secret) return false
  const signature = Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16))
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  // verify() compares in constant time.
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(body))
}

export function webhookEvent(name: string | null, delivery: string | null, payload: Payload, repository: string, appSlug: string): GitHubEvent | undefined {
  const { action, issue, comment } = payload
  // The bridge's own comments and changes came from Matrix already.
  if (!delivery || !issue || issue.pull_request || payload.repository?.full_name !== repository || payload.sender?.login === `${appSlug}[bot]`) return
  if (name === 'issue_comment' && comment) {
    if (action === 'deleted') return { kind: 'delete', issue: issue.number, id: comment.id, delivery }
    if (action !== 'created' && action !== 'edited') return
    const kind = action === 'created' ? 'comment' : 'edit'
    return { kind, issue: issue.number, id: comment.id, body: comment.body ?? '', author: comment.user?.login ?? 'Someone', url: comment.html_url, delivery }
  }
  if (name === 'issues' && (action === 'closed' || action === 'reopened')) {
    const author = payload.sender?.login ?? 'Someone'
    return { kind: 'state', issue: issue.number, state: action, reason: issue.state_reason ?? null, author, url: issue.html_url, delivery }
  }
}
