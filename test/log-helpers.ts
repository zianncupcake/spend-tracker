import { afterEach, vi } from 'vitest'

// What the tests of the service's log share: a catch for all that is written to the console. A test file that
// imports this has the console given back after each of its tests.

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The ways of writing to the console. The log uses `log`, and `error` for the line of a failure, and a test is to
 * see what any of them writes.
 */
const WAYS = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table'] as const

/** What the console would show of one thing that it is given. An error is shown with its message and its stack. */
function shown(given: unknown): string {
  if (typeof given === 'string') return given
  if (given instanceof Error) return `${given.name}: ${given.message}\n${given.stack}`
  return JSON.stringify(given) ?? String(given)
}

/**
 * Catches whatever is written to the console from here to the end of the test, by any of the ways of writing to it,
 * and writes none of it. A test that says what is logged catches it just before what it is about. A test that says
 * what is never logged catches from its first line, so that what its setting up wrote is looked through too.
 */
export function catchConsole() {
  const written: { way: (typeof WAYS)[number]; line: string }[] = []
  for (const way of WAYS) {
    vi.spyOn(console, way).mockImplementation((...given: unknown[]) => {
      written.push({ way, line: given.map(shown).join(' ') })
    })
  }
  return {
    /** All that was written, as text: a line for each time that the console was written to. */
    text: () => written.map(({ line }) => line).join('\n'),
    /**
     * The events that the service logged, in their order: every line, read from the JSON that it is. With a name,
     * only the events of that name. A line that is not JSON fails the test, as the log writes no such line.
     */
    events(name?: string): Record<string, unknown>[] {
      const events: Record<string, unknown>[] = written.map(({ line }) => JSON.parse(line))
      return name === undefined ? events : events.filter((each) => each.event === name)
    },
    /**
     * The events that the service logged as failures, in their order: the lines that were written with
     * console.error, which is what Cloudflare has at the level of an error.
     */
    failures(): Record<string, unknown>[] {
      return written.filter(({ way }) => way === 'error').map(({ line }) => JSON.parse(line))
    },
  }
}
