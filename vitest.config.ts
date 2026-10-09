import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))

  return {
    plugins: [
      cloudflareTest({
        // The real wrangler.jsonc is git-ignored, so tests read the committed example.
        wrangler: { configPath: './wrangler.example.jsonc' },
        miniflare: {
          bindings: {
            // Applied to the local D1 by test/apply-migrations.ts.
            TEST_MIGRATIONS: migrations,
            TELEGRAM_BOT_TOKEN: 'test-token',
            TELEGRAM_WEBHOOK_SECRET: 'test-secret',
            GOOGLE_CLIENT_ID: 'test-client-id',
            GOOGLE_CLIENT_SECRET: 'test-client-secret',
            // Base64 of the bytes 0 to 31.
            TOKEN_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            PUBLIC_BASE_URL: 'https://spend-tracker.test',
            OPERATOR_NAME: 'Example Operator',
            OPERATOR_CONTACT: 'privacy@spend-tracker.test',
          },
          // No test may reach the network. A test that needs an outside
          // service replaces fetch, as test/webhook.test.ts does for Telegram.
          outboundService() {
            throw new Error('A test made a network request')
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // Every test file loads the Worker, and with it the MCP SDK: a hundred or so modules, with what it depends
      // on. Bundled into one module ahead of the tests, they load in about half the time.
      deps: { optimizer: { ssr: { enabled: true, include: ['@modelcontextprotocol/server'] } } },
    },
  }
})
