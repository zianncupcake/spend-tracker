# spend-tracker

A hosted, multi-user expense tracker. Each user talks to a shared Telegram bot. The service reads the user's bank
transaction-alert emails, extracts each purchase, and keeps a running total per credit card for that card's current
window: its statement cycle or the calendar month. Windows are counted in the user's time zone, which is Singapore's
until they set another with `/timezone`.

It runs on Cloudflare Workers with a D1 database.

## Status

Early work. What exists so far: the database schema, the window maths, the Telegram commands, the parsers of bank
alerts, connecting a user's Gmail through Google sign-in, the scheduled check that reads the connected mailboxes,
purchases added and taken out by hand, a catalogue of card products whose reward categories purchases are sorted
into, and an endpoint through which a user's AI assistant can read their totals and purchases.

Two banks are supported so far: OCBC and UOB, both of Singapore, each for its card transaction alerts. A third
parser is for an invented example bank, which the tests use.

## Connecting Gmail

`/connect` in the bot replies with a link to Google sign-in, where the user approves read-only access to their Gmail.
Approving connects nothing by itself. The browser is then shown a 6-digit code, and the mailbox is connected only
when that code is sent in the chat that asked for the link. Without that step, somebody could send their own link
to another person and receive that person's bank alerts. A link is good for one sign-in: once Google has redirected
back from it with a code, it shows as expired, whatever came of that code.

`/disconnect` removes the access and asks Google to revoke it. Revoking ends everything that a Google account has
granted the service, and not only the one token. So it is left undone while the same mailbox is still connected, or
is being connected, from another chat. The same goes for the token of a sign-in that is never finished.

The refresh token is stored encrypted under `TOKEN_ENCRYPTION_KEY`. The OAuth client must have
`<PUBLIC_BASE_URL>/oauth/callback` registered with Google as a redirect URI.

## Checking for alerts

A cron trigger runs the checker every minute. On the Workers free plan a run has about 10 ms of CPU time, 50
outbound requests and 50 database queries. So each run checks one mailbox, the one that has waited longest, and
reads at most one alert from it (`MESSAGES_PER_RUN` in `src/checker.ts`): a run that read three took 14 ms of CPU
time. With N mailboxes connected, each is checked every N minutes. A mailbox that is connected, or connected again,
has waited since then: it takes its place behind the others and not ahead of them.

A run searches the mailbox for mail from the addresses that the banks send alerts from: from 35 days before the
connection was made and, once the mailbox has been fully checked, from a day before the last full check. Gmail
lists what it finds a page of 100 at a time, newest first, and a run asks for five pages at most. It begins with
the first page, where new mail is. When it knows everything on the pages it has asked for, it keeps the place it
got to, and the next run goes on from there.

Anyone can write a bank's address on an email, so an alert is read only when the `Authentication-Results` header
that Gmail itself added shows a DMARC pass for the domain of that address, or for a domain that it is under: Gmail
names the domain that the sender's DMARC policy is for, which for `noreply@notify.ocbc.com` is `ocbc.com`. That is
decided on a message's headers, which are fetched by themselves: a message is fetched whole only once it has
passed. A run fetches the headers of at most ten messages (`HEADER_CHECKS_PER_RUN`), so it is through mail that
only looks like an alert sooner than it could read it. A message that is looked at but not stored is remembered by
its id, and is not fetched again.

The user is told of a purchase that is less than six hours old. Older ones are stored without a message, so that a
new connection catching up does not flood the chat. A merchant's name is text taken from an email, and Telegram
makes a command or a link of whatever looks like one. So the name is sent marked as code, in which nothing can be
tapped. For a card that is linked to a product, the message ends with where the purchase was sorted, or with the
buttons that sort it.

The search leaves out any message of 1 MB or more. An alert is a few kilobytes, and a message is parsed whole once
it is fetched, so a huge one with a bank's address on it could take all the CPU time of every run that came upon it.

When Google no longer honours a connection's token, the user is told and the connection is marked as needing to be
reconnected. It is marked only once the message has been sent, so one that fails is sent again on the mailbox's
next turn, unless the user has blocked the bot. `/status` shows how the checking is going. Each run also deletes up
to five sign-ins that were never finished and have expired, and asks Google to revoke any token that one of them
held, with the exception described under Connecting Gmail.

## Purchases one by one

`/spend <nickname>` lists every purchase of a card's current window from the earliest on, each with an id such as
`#57`, and then what they come to. It lists the latest 200 when a window holds more. Telegram takes 4,096 characters
in a message and shows no more than 100 marked stretches of one, so a long window is sent as several messages, each
of which ends at the end of a line.

`/add <nickname> <amount> <merchant>` records a purchase by hand, for a time that no alert covers. A date can go
before the merchant: `YYYY-MM-DD`, `D/M` for a day of the current year, or `D/M/YY`. The purchase is then dated noon
of that day in the user's time zone. The amount can have a currency before it, as in `USD 12.50`. Without one it is
in the currency of the card's product, or in SGD.

`/remove <purchase id>` takes a purchase out. Its row is kept and marked, so that the alert it was read from still
counts as known and is never stored again. Whatever totals, lists or counts purchases leaves a marked row out.

## Card products and reward categories

The service knows the reward rules of some card products. They are data, in `src/catalogue/`: a file for each
product, which also says where the bank publishes its terms and what date those terms are as of. So far there is
one, the UOB EVOL Card (`uob-evol`). `/products` lists them, `/product <nickname> <product key>` links a card to one
(`none` in place of the key unlinks it), and `/addcard` takes the key as a last word.

A purchase on a linked card is sorted into one of the product's categories. Some categories are given by a rule: to
a purchase in another currency than the product's, and to one whose merchant's name holds a name that the product
lists. The others are chosen by the user, with the buttons under the bot's message about the purchase or with
`/sort`: `/sort <nickname>` goes through a card's unsorted purchases one by one, and `/sort <purchase id>` sorts one
purchase again. What a user chooses for a merchant is remembered, and their later purchases there start in that
category. Sorting one purchase changes no other. Linking a card sorts the purchases of its current window that a
rule settles and that are not sorted yet.

For a linked card, `/spend <nickname>` ends with what the product makes of the window: what was spent in each group
of categories beside the group's limit, what is not sorted, what does not count, and how far the spend is towards
the product's minimum. Purchases in other currencies are left out of the minimum spend, as what they come to in the
card's own currency is not known.

A press of a button reaches the bot as a `callback_query` update. A webhook that was set with a list of
`allowed_updates` has to have `callback_query` in that list. A press is acted on only for a purchase of the user who
pressed, in their own private chat, and what a button sends back is checked as anything else from outside is.

## Connecting an AI assistant

A user can let an AI assistant, such as Claude Code, read their card totals and purchases. For that the service is
a remote [MCP](https://modelcontextprotocol.io) server at `<PUBLIC_BASE_URL>/mcp`, over the Streamable HTTP
transport.

`/mcp` in the bot replies with an access token, and with the command that adds the server to Claude Code:

```sh
claude mcp add --transport http spend-tracker <PUBLIC_BASE_URL>/mcp --header "Authorization: Bearer <token>"
```

The token is shown that once, and only its SHA-256 hash is stored. Whoever holds it can read that one user's data
and can change nothing. Sending `/mcp` again replaces the token, `/mcp revoke` removes it, and `/delete confirm`
removes it with everything else.

The server has two tools, and both only read:

- `get_spending_summary`: each card's current window, with its total per currency and its number of purchases.
- `list_transactions`: purchases, newest first, each with its id and the category it is sorted into. It takes a
  card's nickname (`card`), where to start and end (`from` and `to`: a date, which is a day in the user's time
  zone, or an instant) and how many to return (`limit`: 50 unless told, and 200 at most). Without `from` and `to`
  it covers the last 30 days.

A merchant's name is text taken from an email, so it is not to be trusted. It is only ever returned inside a JSON
string, and the tool's description tells the assistant to treat it as data and never as instructions.

The protocol is the work of the official SDK, `@modelcontextprotocol/server`, which is the project's one runtime
dependency. Its handler keeps nothing between requests: there are no sessions, and no stream is held open (a `GET`
is answered 405). It answers the 2026-07-28 revision of the protocol, and the older revisions that open with
`initialize`.

## Known limits

- A purchase message that Telegram fails to accept is not sent again. The purchase is stored all the same, so the
  totals are unaffected.
- A user can have 20 cards at most.
- A category that only a rule gives has no button. So a purchase that its user has moved out of one cannot be moved
  back into it by hand.
- A purchase that has been taken out cannot be put back. It can be added again by hand.

## Development

```sh
npm install
npm test           # vitest, against a local D1 database with the migrations applied
npm run typecheck  # tsc --noEmit
```

`wrangler.example.jsonc` and `.dev.vars.example` are templates. Their real counterparts, `wrangler.jsonc` and
`.dev.vars`, are git-ignored. The comments in `.dev.vars.example` say what the less obvious settings are.
