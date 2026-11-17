import { verifySignature, webhookEvent } from './webhook'

export { Bridge } from './bridge'

function bridge(env: Env) {
  return env.BRIDGE.getByName('bridge')
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/github') return new Response('Not found', { status: 404 })
    const body = await request.text()
    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) {
      return new Response('Invalid signature', { status: 401 })
    }
    const event = webhookEvent(
      request.headers.get('x-github-event'),
      request.headers.get('x-github-delivery'),
      JSON.parse(body),
      env.GITHUB_REPOSITORY,
      env.GITHUB_APP_SLUG,
    )
    if (event) await bridge(env).receive(event)
    return new Response(null, { status: 204 })
  },

  async scheduled(_controller, env) {
    await bridge(env).start()
  },
} satisfies ExportedHandler<Env>
