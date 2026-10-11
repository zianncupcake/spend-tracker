// Writes wrangler.jsonc, the real config, for a deploy: .github/workflows/ci.yml runs this before it runs wrangler.
// The real config is kept out of the repository, because it holds the id of the database and who runs the service.
// So it is made here from wrangler.example.jsonc and the environment, and the two cannot drift: what is deployed is
// the example, with the id of the database in its one D1 entry and with the three vars.
//
// Nothing of what is written is printed. A variable that is not set, or is empty, is named, and no value ever is.
//
// It writes over a wrangler.jsonc that is there already, so it is not to be run in a folder that has a real one.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')

/** What the environment has to hold: the id of the D1 database, and the vars of the Worker by their own names. */
const DATABASE_ID = 'D1_DATABASE_ID'
const VARS = ['PUBLIC_BASE_URL', 'OPERATOR_NAME', 'OPERATOR_CONTACT']

const missing = [DATABASE_ID, ...VARS].filter((name) => !process.env[name])
if (missing.length > 0) fail(`Not set, or empty: ${missing.join(', ')}`)

// The example is JSON with // comments. A string is matched whole and kept, so that a // inside one, as an address
// has, is not taken for a comment.
const example = readFileSync(path.join(root, 'wrangler.example.jsonc'), 'utf8')
const config = JSON.parse(example.replace(/("(?:\\.|[^"\\])*")|\/\/.*/g, '$1'))

// The id is for the one D1 entry. For an entry that was left with no id, wrangler would find a database by its name,
// or make one.
const databases = config.d1_databases
if (!Array.isArray(databases) || databases.length !== 1) {
  fail('wrangler.example.jsonc has to have exactly one entry in d1_databases')
}
databases[0].database_id = process.env[DATABASE_ID]
config.vars = { ...config.vars, ...Object.fromEntries(VARS.map((name) => [name, process.env[name]])) }

writeFileSync(path.join(root, 'wrangler.jsonc'), `${JSON.stringify(config, null, 2)}\n`)
console.log('Wrote wrangler.jsonc')

function fail(message) {
  console.error(message)
  process.exit(1)
}
