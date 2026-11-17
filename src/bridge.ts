import { DurableObject } from 'cloudflare:workers'
import { GitHub } from './github'
import { describe, type Fetch, HttpError } from './http'
import { Matrix, type MatrixEvent, type MessageContent, messageText, permalink, threadRelation } from './matrix'
import { commentBody, escapeHtml, issueBody, limits, type Notice, notices, parseCommand, removedReport } from './text'
import type { GitHubEvent } from './webhook'

const pollInterval = 15_000
const hour = 3_600_000
const day = 24 * hour
// Leaves room for the HTML copy within Matrix's 64 KiB event limit.
const maxRelayedText = 20_000

interface Thread {
  root: string
  source: string
  room: string
  issue: number
  reporter: string
}

interface Message {
  event: string
  room: string
  issue: number
  comment: number
  sender: string
  origin: 'matrix' | 'github'
}

const schema = [
  'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // root is the Matrix thread, source the command event that filed the issue.
  'CREATE TABLE IF NOT EXISTS threads (root TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, room TEXT NOT NULL, issue INTEGER NOT NULL UNIQUE, reporter TEXT NOT NULL)',
  // Pairs each Matrix event with the GitHub comment it mirrors, in either direction.
  'CREATE TABLE IF NOT EXISTS messages (event TEXT PRIMARY KEY, room TEXT NOT NULL, issue INTEGER NOT NULL, comment INTEGER NOT NULL UNIQUE, sender TEXT NOT NULL, origin TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS usage (user TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS usage_user ON usage (user, kind, at)',
  'CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)',
]

// Skips events that can never succeed and keeps the rest for the next tick.
function permanent(error: unknown) {
  return error instanceof HttpError && !error.retry
}

export class Bridge extends DurableObject<Env> {
  // Replaced in tests.
  http: Fetch = (input, init) => fetch(input, init)
  private sql = this.ctx.storage.sql
  private rooms = this.env.MATRIX_ROOMS.split(',').map(room => room.trim()).filter(Boolean)
  private matrix = new Matrix(this.env.MATRIX_HOMESERVER, this.env.MATRIX_ACCESS_TOKEN, (input, init) => this.http(input, init))
  private github = new GitHub(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY, this.env.GITHUB_REPOSITORY, (input, init) => this.http(input, init))

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    for (const statement of schema) this.sql.exec(statement)
  }

  async start() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now())
  }

  async receive(event: GitHubEvent) {
    this.sql.exec('INSERT INTO outbox (payload) VALUES (?)', JSON.stringify(event))
    await this.ctx.storage.setAlarm(Date.now())
  }

  async alarm() {
    try {
      await this.tick()
    } catch (error) {
      console.error(`Bridge tick failed: ${describe(error)}`)
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + pollInterval)
    }
  }

  async tick() {
    if (!this.rooms.length) throw new Error('MATRIX_ROOMS is empty')
    await this.drain()
    await this.poll()
  }

  private state(key: string) {
    return this.sql.exec<{ value: string }>('SELECT value FROM state WHERE key = ?', key).toArray()[0]?.value
  }

  private setState(key: string, value: string) {
    this.sql.exec('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  private find<T>(query: string, ...bindings: (string | number)[]) {
    return this.sql.exec(query, ...bindings).toArray()[0] as T | undefined
  }

  private used(kind: string, since: number, user?: string) {
    const query = `SELECT COUNT(*) AS count FROM usage WHERE kind = ? AND at > ?${user ? ' AND user = ?' : ''}`
    return this.sql.exec<{ count: number }>(query, kind, Date.now() - since, ...(user ? [user] : [])).one().count
  }

  private use(kind: string, user: string) {
    this.sql.exec('INSERT INTO usage (user, kind, at) VALUES (?, ?, ?)', user, kind, Date.now())
  }

  private async poll() {
    // Joining is idempotent, so a changed room list only has to be joined again.
    if (this.state('rooms') !== this.rooms.join(',')) {
      for (const room of this.rooms) await this.matrix.join(room)
      this.setState('rooms', this.rooms.join(','))
    }
    const since = this.state('since')
    if (!since) {
      // Starts from now instead of filing old room history.
      this.setState('user', await this.matrix.whoami())
      this.setState('since', (await this.matrix.sync(this.rooms)).next_batch)
      return
    }
    const sync = await this.matrix.sync(this.rooms, since)
    for (const [room, { timeline }] of Object.entries(sync.rooms?.join ?? {})) {
      if (!this.rooms.includes(room)) continue
      for (const event of timeline?.events ?? []) {
        try {
          await this.handle(room, event)
        } catch (error) {
          // Until the batch is acknowledged, the next tick receives it again. Every step is
          // idempotent, so events handled before the failure are not mirrored twice.
          if (!permanent(error)) throw error
          console.error(`Skipped Matrix event: ${describe(error)}`)
        }
      }
    }
    this.setState('since', sync.next_batch)
    this.sql.exec('DELETE FROM usage WHERE at < ?', Date.now() - day)
  }

  private async handle(room: string, event: MatrixEvent) {
    if (event.sender === this.state('user')) return
    if (event.type === 'm.room.redaction') return this.redacted(event.redacts ?? event.content.redacts)
    if (event.type !== 'm.room.message') return
    const relation = event.content['m.relates_to']
    if (relation?.rel_type === 'm.replace') return this.edited(event.sender, relation.event_id, event.content['m.new_content'])
    // Notices come from bots, which must not talk to each other.
    if (event.content.msgtype === 'm.notice') return
    const root = (relation?.rel_type === 'm.thread' && relation.event_id) || event.event_id
    const thread = this.find<Thread>('SELECT * FROM threads WHERE root = ?', root)
    // A retry after the issue was filed only needs to confirm it.
    if (thread?.source === event.event_id) return this.notice(room, root, `filed:${event.event_id}`, notices.filed(thread.issue, this.issueUrl(thread.issue)))
    if (thread) return this.reply(room, event, thread)
    const text = messageText(event.content)
    const command = text === undefined ? undefined : parseCommand(text)
    if (!command) return
    if (command.kind === 'help' || !command.title) return this.notice(room, root, `help:${event.event_id}`, notices.help)
    if (this.used('report', day, event.sender) >= limits.reportsPerUser || this.used('report', day) >= limits.reportsTotal) {
      return this.notice(room, root, `limit:${event.event_id}`, notices.limit)
    }
    let issue
    try {
      issue = await this.github.createIssue({
        title: command.title,
        body: issueBody(event.sender, permalink(room, event.event_id), command.description),
        type: command.kind === 'bug' ? 'Bug' : 'Feature',
      })
    } catch (error) {
      if (permanent(error)) await this.notice(room, root, `failed:${event.event_id}`, notices.failed)
      throw error
    }
    this.sql.exec(
      'INSERT INTO threads (root, source, room, issue, reporter) VALUES (?, ?, ?, ?, ?)',
      root,
      event.event_id,
      room,
      issue.number,
      event.sender,
    )
    this.use('report', event.sender)
    await this.notice(room, root, `filed:${event.event_id}`, notices.filed(issue.number, issue.html_url))
  }

  private issueUrl(issue: number) {
    return `https://github.com/${this.env.GITHUB_REPOSITORY}/issues/${issue}`
  }

  private async reply(room: string, event: MatrixEvent, thread: Thread) {
    if (this.find('SELECT 1 FROM messages WHERE event = ?', event.event_id)) return
    const text = messageText(event.content)
    if (text === undefined) {
      const isFile = ['m.image', 'm.file', 'm.video', 'm.audio'].includes(event.content.msgtype ?? '')
      return isFile ? this.notice(room, thread.root, `file:${event.event_id}`, notices.file) : undefined
    }
    const used = this.used('reply', hour, event.sender)
    if (used >= limits.repliesPerUser) {
      this.use('reply', event.sender)
      // Says so once instead of answering every message of a flood.
      return used === limits.repliesPerUser ? this.notice(room, thread.root, `slow:${event.event_id}`, notices.slow) : undefined
    }
    const comment = await this.github.comment(thread.issue, commentBody(event.sender, permalink(room, event.event_id), text))
    this.sql.exec(
      "INSERT INTO messages (event, room, issue, comment, sender, origin) VALUES (?, ?, ?, ?, ?, 'matrix')",
      event.event_id,
      room,
      thread.issue,
      comment,
      event.sender,
    )
    this.use('reply', event.sender)
  }

  // Matrix accepts edits from anyone, so only the original sender's are mirrored.
  private async edited(sender: string, target: string | undefined, content: MessageContent | undefined) {
    const text = messageText(content)
    if (!target || text === undefined) return
    const thread = this.find<Thread>('SELECT * FROM threads WHERE source = ? AND reporter = ?', target, sender)
    if (thread) {
      const command = parseCommand(text)
      if (!command?.title || command.kind === 'help') return
      const body = issueBody(sender, permalink(thread.room, target), command.description)
      return this.github.updateIssue(thread.issue, { title: command.title, body })
    }
    const message = this.find<Message>("SELECT * FROM messages WHERE event = ? AND sender = ? AND origin = 'matrix'", target, sender)
    if (message) await this.github.editComment(message.comment, commentBody(sender, permalink(message.room, target), text))
  }

  // Senders and moderators can redact, and both should take the text off GitHub.
  private async redacted(target: string | undefined) {
    if (!target) return
    const thread = this.find<Thread>('SELECT * FROM threads WHERE source = ?', target)
    if (thread) return this.github.updateIssue(thread.issue, { ...removedReport, state: 'closed', state_reason: 'not_planned' })
    const message = this.find<Message>("SELECT * FROM messages WHERE event = ? AND origin = 'matrix'", target)
    if (!message) return
    try {
      await this.github.deleteComment(message.comment)
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
    this.sql.exec('DELETE FROM messages WHERE event = ?', target)
  }

  private async notice(room: string, root: string, transaction: string, notice: Notice) {
    await this.matrix.send(room, transaction, {
      msgtype: 'm.notice',
      body: notice.body,
      ...(notice.html && { format: 'org.matrix.custom.html', formatted_body: notice.html }),
      'm.mentions': {},
      'm.relates_to': threadRelation(root),
    })
  }

  private async drain() {
    const rows = this.sql.exec<{ id: number; payload: string }>('SELECT id, payload FROM outbox ORDER BY id').toArray()
    for (const { id, payload } of rows) {
      try {
        await this.deliver(JSON.parse(payload) as GitHubEvent)
      } catch (error) {
        if (!permanent(error)) throw error
        console.error(`Skipped GitHub event: ${describe(error)}`)
      }
      this.sql.exec('DELETE FROM outbox WHERE id = ?', id)
    }
  }

  private async relayed(event: Extract<GitHubEvent, { body: string }>) {
    const header = `${event.author} on GitHub`
    if (event.body.length > maxRelayedText) {
      const body = `${header}: ${event.body.slice(0, maxRelayedText)}…\n\nRead the rest on GitHub: ${event.url}`
      return { msgtype: 'm.text', body }
    }
    const html = await this.github.render(event.body)
    return {
      msgtype: 'm.text',
      body: `${header}: ${event.body}`,
      format: 'org.matrix.custom.html',
      formatted_body: `<p><strong>${escapeHtml(event.author)}</strong> on <a href="${escapeHtml(event.url)}">GitHub</a>:</p>${html}`,
    }
  }

  private async deliver(event: GitHubEvent) {
    const thread = this.find<Thread>('SELECT * FROM threads WHERE issue = ?', event.issue)
    if (!thread) return
    const mentions = { user_ids: [thread.reporter] }
    if (event.kind === 'state') {
      const reason = event.reason === 'not_planned' ? ' as not planned' : event.reason === 'duplicate' ? ' as a duplicate' : ''
      const action = event.state === 'closed' ? `closed this issue${reason}` : 'reopened this issue'
      return this.matrix.send(thread.room, `gh-state:${event.delivery}`, {
        msgtype: 'm.notice',
        body: `${event.author} ${action} on GitHub: ${event.url}`,
        format: 'org.matrix.custom.html',
        formatted_body: `<p>${escapeHtml(event.author)} ${action} on <a href="${escapeHtml(event.url)}">GitHub</a>.</p>`,
        'm.mentions': mentions,
        'm.relates_to': threadRelation(thread.root),
      })
    }
    const message = this.find<Message>("SELECT * FROM messages WHERE comment = ? AND origin = 'github'", event.id)
    if (event.kind === 'comment') {
      if (message) return
      const content = await this.relayed(event)
      const sent = await this.matrix.send(thread.room, `gh-comment:${event.id}`, {
        ...content,
        'm.mentions': mentions,
        'm.relates_to': threadRelation(thread.root),
      })
      this.sql.exec(
        "INSERT INTO messages (event, room, issue, comment, sender, origin) VALUES (?, ?, ?, ?, ?, 'github')",
        sent,
        thread.room,
        thread.issue,
        event.id,
        event.author,
      )
      return
    }
    if (!message) return
    if (event.kind === 'edit') {
      const content = await this.relayed(event)
      return this.matrix.send(thread.room, `gh-edit:${event.delivery}`, {
        ...content,
        body: `* ${content.body}`,
        'm.new_content': { ...content, 'm.mentions': {} },
        'm.mentions': {},
        'm.relates_to': { rel_type: 'm.replace', event_id: message.event },
      })
    }
    await this.matrix.redact(thread.room, message.event, `gh-delete:${event.delivery}`)
    this.sql.exec('DELETE FROM messages WHERE event = ?', message.event)
  }
}
