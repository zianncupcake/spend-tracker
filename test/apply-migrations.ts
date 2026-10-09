import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Setup files can run more than once. That is safe: only migrations that have
// not been applied yet are run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
