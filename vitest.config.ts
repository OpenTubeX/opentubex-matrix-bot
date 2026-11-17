import { generateKeyPairSync } from 'node:crypto'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          MATRIX_HOMESERVER: 'https://matrix.test',
          MATRIX_ROOMS: '!room:example.org',
          GITHUB_APP_ID: '1',
          GITHUB_APP_SLUG: 'opentubex-matrix',
          MATRIX_ACCESS_TOKEN: 'matrix-token',
          GITHUB_APP_PRIVATE_KEY: privateKey,
          GITHUB_WEBHOOK_SECRET: 'webhook-secret',
        },
      },
    }),
  ],
})
