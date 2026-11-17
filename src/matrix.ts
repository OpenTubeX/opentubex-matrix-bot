import { type Fetch, HttpError } from './http'

export interface Relation {
  rel_type?: string
  event_id?: string
  is_falling_back?: boolean
  'm.in_reply_to'?: { event_id?: string }
}

export interface MessageContent {
  msgtype?: string
  body?: unknown
  'm.relates_to'?: Relation
  'm.new_content'?: MessageContent
  redacts?: string
  [key: string]: unknown
}

export interface MatrixEvent {
  type: string
  event_id: string
  sender: string
  content: MessageContent
  redacts?: string
}

export interface SyncResponse {
  next_batch: string
  rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> }
}

export class Matrix {
  constructor(
    private homeserver: string,
    private token: string,
    private http: Fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.http(`${this.homeserver.replace(/\/$/, '')}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new HttpError('Matrix', method, path, response)
    return (await response.json()) as T
  }

  async whoami() {
    return (await this.request<{ user_id: string }>('GET', '/account/whoami')).user_id
  }

  async join(room: string) {
    await this.request('POST', `/join/${encodeURIComponent(room)}`, {})
  }

  sync(rooms: string[], since?: string) {
    const nothing = { not_types: ['*'] }
    const filter = {
      presence: nothing,
      account_data: nothing,
      room: {
        rooms,
        account_data: nothing,
        ephemeral: nothing,
        state: { ...nothing, lazy_load_members: true },
        timeline: { types: ['m.room.message', 'm.room.redaction'], limit: 100 },
      },
    }
    const query = new URLSearchParams({ filter: JSON.stringify(filter), timeout: '0' })
    if (since) query.set('since', since)
    return this.request<SyncResponse>('GET', `/sync?${query}`)
  }

  // Homeservers drop repeated transaction IDs, so retried sends never post twice.
  async send(room: string, transaction: string, content: Record<string, unknown>) {
    const path = `/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(transaction)}`
    return (await this.request<{ event_id: string }>('PUT', path, content)).event_id
  }

  async redact(room: string, event: string, transaction: string) {
    await this.request('PUT', `/rooms/${encodeURIComponent(room)}/redact/${encodeURIComponent(event)}/${encodeURIComponent(transaction)}`, {})
  }
}

export function permalink(room: string, event: string) {
  return `https://matrix.to/#/${encodeURIComponent(room)}/${encodeURIComponent(event)}`
}

export function threadRelation(root: string): Relation {
  return { rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: root } }
}

// Returns the text of a typed message, without the quoted reply fallback older clients add.
export function messageText(content: MessageContent | undefined) {
  if (!content || typeof content.body !== 'string' || !['m.text', 'm.emote'].includes(content.msgtype ?? '')) return
  const relation = content['m.relates_to']
  const isReply = relation?.['m.in_reply_to'] && !relation.is_falling_back
  return (isReply ? content.body.replace(/^(?:>.*\n)+\n/, '') : content.body).trim()
}
