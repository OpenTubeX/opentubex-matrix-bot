import { env, exports } from 'cloudflare:workers'
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { edit, fakeServices, inThread, message, redaction, room } from './fake'

const alice = '@alice:example.org'
const bob = '@bob:example.org'
const stub = () => env.BRIDGE.getByName('bridge')
let services: ReturnType<typeof fakeServices>

async function tick() {
  await runInDurableObject(stub(), async instance => {
    instance.http = services.http
    await instance.tick()
  })
}

async function webhook(event: string, payload: unknown, secret = 'webhook-secret') {
  const body = JSON.stringify(payload)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const hex = Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')
  return exports.default.fetch(
    new Request('https://bot.test/github', {
      method: 'POST',
      body,
      headers: { 'x-github-event': event, 'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': `sha256=${hex}` },
    }),
  )
}

const comment = (id: number, login: string, body: string) => ({
  action: 'created',
  repository: { full_name: 'OpenTubeX/OpenTubeX' },
  sender: { login },
  issue: { number: 101, html_url: 'https://github.com/OpenTubeX/OpenTubeX/issues/101' },
  comment: { id, body, user: { login }, html_url: `https://github.com/OpenTubeX/OpenTubeX/issues/101#issuecomment-${id}` },
})

beforeEach(async () => {
  services = fakeServices()
  // Joins the room and skips its history.
  await tick()
})

afterEach(() => reset())

it('files a report and mirrors its thread both ways', async () => {
  services.batch('s0', 's1', [
    message('$report', alice, '!bug Player freezes\nIt stops after @someone joins. `@code` stays.'),
    message('$help', bob, '!bug'),
    message('$chat', bob, 'Hello'),
  ])
  await tick()

  expect(services.github('POST', '/issues')).toEqual([
    expect.objectContaining({
      body: {
        title: 'Player freezes',
        type: 'Bug',
        body: `Reported by \`${alice}\` on [Matrix](https://matrix.to/#/${encodeURIComponent(room)}/%24report).\n\nIt stops after @⁠someone joins. \`@code\` stays.`,
      },
    }),
  ])
  const [filed, help] = services.sent()
  expect(filed.body).toMatchObject({ msgtype: 'm.notice', 'm.relates_to': inThread('$report') })
  expect(filed.body?.body).toContain('#101')
  expect(help.body).toMatchObject({ 'm.relates_to': inThread('$help') })
  expect(services.sent()).toHaveLength(2)

  services.batch('s1', 's2', [
    message('$reply', bob, 'Same here', inThread('$report')),
    edit('$fix', bob, '$reply', 'Same here on Android'),
    edit('$forged', bob, '$report', '!bug Something else'),
    redaction('$removed', '@mod:example.org', '$reply'),
  ])
  await tick()

  const posted = services.github('POST', '/issues/101/comments')
  expect(posted).toHaveLength(1)
  expect(posted[0].body?.body).toMatch(new RegExp(`^\`${bob}\` on \\[Matrix\\]\\(.+%24reply\\):\n\nSame here$`))
  expect(services.github('PATCH', '/issues/comments/1001')[0].body?.body).toContain('Same here on Android')
  expect(services.github('PATCH', '/issues/101')).toEqual([])
  expect(services.github('DELETE', '/issues/comments/1001')).toHaveLength(1)

  const sentBefore = services.sent().length
  expect((await webhook('issue_comment', comment(5, 'maintainer', 'Which version?'), 'wrong')).status).toBe(401)
  expect((await webhook('issue_comment', comment(6, 'opentubex-matrix[bot]', 'Mirrored'))).status).toBe(204)
  expect((await webhook('issue_comment', comment(7, 'maintainer', 'Which version?'))).status).toBe(204)
  await runInDurableObject(stub(), instance => {
    instance.http = services.http
  })
  await runDurableObjectAlarm(stub())

  const relayed = services.sent().slice(sentBefore)
  expect(relayed).toHaveLength(1)
  expect(relayed[0].body).toMatchObject({
    msgtype: 'm.text',
    body: 'maintainer on GitHub: Which version?',
    'm.mentions': { user_ids: [alice] },
    'm.relates_to': inThread('$report'),
  })
  expect(relayed[0].body?.formatted_body).toContain('<p>Which version?</p>')
})

it('retries a failed batch without filing twice', async () => {
  services.batch('s0', 's1', [message('$first', alice, '!bug First'), message('$second', bob, '!feature Second')])
  // The first report is filed, then GitHub fails on the second.
  let attempts = 0
  const http = services.http
  services.http = async (input, init) => {
    if (init?.method === 'POST' && new URL(input).pathname === '/repos/OpenTubeX/OpenTubeX/issues' && ++attempts === 2) {
      return Response.json({}, { status: 502 })
    }
    return http(input, init)
  }
  await expect(tick()).rejects.toThrow('failed with 502')
  await tick()
  await tick()

  const filed = services.github('POST', '/issues').map(call => call.body?.title)
  expect(filed).toEqual(['First', 'Second'])
  // The repeated confirmation reuses its transaction ID, so the homeserver drops it.
  const confirmations = services.sent().map(call => decodeURIComponent(call.path.split('/').at(-1) ?? ''))
  expect(confirmations).toEqual(['filed:$first', 'filed:$first', 'filed:$second'])
})

it('limits reports per Matrix user', async () => {
  services.batch(
    's0',
    's1',
    ['$1', '$2', '$3', '$4'].map(id => message(id, alice, `!bug Report ${id}`)),
  )
  await tick()

  expect(services.github('POST', '/issues')).toHaveLength(3)
  expect(services.sent().at(-1)?.body?.body).toMatch(/^Too many reports today/)
})
