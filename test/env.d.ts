declare namespace Cloudflare {
  interface Env {
    // Test-only binding, defined in vitest.config.ts.
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
