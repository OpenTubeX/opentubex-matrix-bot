import type { MatrixEvent, SyncResponse } from '../src/matrix'

export const room = '!room:example.org'
export const bot = '@bot:example.org'
const repo = '/repos/OpenTubeX/OpenTubeX'

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

// Answers the Matrix and GitHub endpoints the bridge uses and records every request.
export function fakeServices() {
  const calls: Call[] = []
  const batches = new Map<string, SyncResponse>()
  let issue = 100
  let comment = 1000
  let sent = 0

  async function http(input: string, init: RequestInit = {}) {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const path = url.hostname === 'matrix.test' ? url.pathname.replace('/_matrix/client/v3', '') : url.pathname
    calls.push({ method, path, body })
    if (url.hostname === 'api.github.com') {
      if (path === `${repo}/installation`) return json({ id: 7 })
      if (path === '/app/installations/7/access_tokens') return json({ token: 'installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201)
      if (method === 'POST' && path === `${repo}/issues`) {
        issue++
        return json({ number: issue, html_url: `https://github.com/OpenTubeX/OpenTubeX/issues/${issue}` }, 201)
      }
      const lookup = method === 'GET' && path.match(/\/issues\/(\d+)$/)?.[1]
      if (lookup) {
        if (lookup === '999') return json({}, 404)
        return json({ number: Number(lookup), title: `Issue ${lookup}`, state: 'open', html_url: `https://github.com/OpenTubeX/OpenTubeX/issues/${lookup}` })
      }
      if (method === 'POST' && path.endsWith('/comments')) return json({ id: ++comment }, 201)
      if (path === '/markdown') return new Response(`<p>${String(body?.text)}</p>`, { headers: { 'content-type': 'text/html' } })
      if (method === 'PATCH') return json({})
      if (method === 'DELETE') return new Response(null, { status: 204 })
    }
    if (url.hostname === 'matrix.test') {
      if (path === '/account/whoami') return json({ user_id: bot })
      if (path.startsWith('/join/')) return json({ room_id: room })
      if (path === '/sync') {
        const since = url.searchParams.get('since')
        return json(since ? (batches.get(since) ?? { next_batch: since }) : { next_batch: 's0' })
      }
      if (method === 'PUT') return json({ event_id: `$bot${++sent}` })
    }
    return json({ error: `Unexpected ${method} ${url}` }, 418)
  }

  return {
    http,
    calls,
    // Serves events to the sync that starts at `since`, as often as it is requested.
    batch(since: string, next: string, events: MatrixEvent[]) {
      batches.set(since, { next_batch: next, rooms: { join: { [room]: { timeline: { events } } } } })
    },
    github: (method: string, path = '') => calls.filter(call => call.method === method && call.path.startsWith(`${repo}${path}`)),
    sent: () => calls.filter(call => call.method === 'PUT' && call.path.includes('/send/')),
  }
}

export function message(id: string, sender: string, body: string, relation?: Record<string, unknown>, extra: Record<string, unknown> = {}): MatrixEvent {
  return {
    type: 'm.room.message',
    event_id: id,
    sender,
    content: { msgtype: 'm.text', body, ...(relation && { 'm.relates_to': relation }), ...extra },
  }
}

export const inThread = (root: string) => ({ rel_type: 'm.thread', event_id: root, is_falling_back: true, 'm.in_reply_to': { event_id: root } })

export function edit(id: string, sender: string, target: string, body: string) {
  return message(id, sender, `* ${body}`, { rel_type: 'm.replace', event_id: target }, { 'm.new_content': { msgtype: 'm.text', body } })
}

export function redaction(id: string, sender: string, target: string): MatrixEvent {
  return { type: 'm.room.redaction', event_id: id, sender, redacts: target, content: { redacts: target } }
}
