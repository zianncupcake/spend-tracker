-- Gmail access through Google sign-in. A refresh token is only ever stored
-- encrypted, under a key that is a secret of the Worker and not in the database.

CREATE TABLE google_connections (
  owner_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect')),
  -- For the mail checker. Null until the mailbox has been checked once.
  last_checked_at INTEGER,
  -- For the mail checker too: how far its runs have got through a mailbox that
  -- holds more known alerts than one run can page through. It is the token of
  -- the page of the search that the next run goes on from, or null.
  backlog_page_token TEXT,
  -- By the service's clock and not the database's, as the mail checker compares
  -- it with the times of its runs.
  connected_at INTEGER NOT NULL
) STRICT;

-- A sign-in in progress. A user has one at most: a new /connect replaces it.
CREATE TABLE connect_attempts (
  owner_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- The state is in the link the user is sent. Only its SHA-256 hash is kept.
  state_hash TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Set to 1 when Google redirects back with the state and a code. From then on
  -- the state opens nothing, so no second code is taken to Google with it.
  claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0, 1)),
  -- The next three are null until that code has been exchanged for a mailbox.
  -- From then on the attempt waits for its confirmation code.
  email TEXT,
  refresh_token_enc TEXT,
  confirm_code_hash TEXT,
  confirm_tries INTEGER NOT NULL DEFAULT 0,
  CHECK ((email IS NULL) = (confirm_code_hash IS NULL)),
  CHECK ((refresh_token_enc IS NULL) = (confirm_code_hash IS NULL))
) STRICT;
