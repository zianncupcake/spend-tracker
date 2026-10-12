import { parsers } from '../src/parsers'
import { exampleBank } from './example-bank'

// The service has no parser of the bank that the tests invent, so every test file is given it here: once, as each
// file has its own copy of the list. It goes first, where the tests of what a run asks of Gmail have its address.
parsers.unshift(exampleBank)
