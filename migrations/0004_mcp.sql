-- The token that lets a user's AI assistant read their card totals and
-- purchases through the MCP endpoint. A user has one at most: a new /mcp
-- replaces it.

CREATE TABLE mcp_tokens (
  owner_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- The token is shown to its user once. Only its SHA-256 hash is kept.
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
