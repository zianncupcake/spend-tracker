# spend-tracker

A Telegram bot that tracks what is spent on credit cards. It reads the transaction alert emails that a user's bank
sends to their Gmail, takes the purchase out of each one, and keeps a running total for each card over the card's
current window: its statement cycle or the calendar month. One deployment serves many users, each in their own
private chat with the bot.

It also has an assistant that answers plain messages and can do what the commands do, it reads a photo of purchases
and adds them, and it has a read-only MCP endpoint through which a user's own AI assistant can read their totals
and purchases. The assistant and the reading of photos need an AI provider. A service without one does the rest.

It runs on Cloudflare Workers with a D1 database, and it is built for free plans: the Workers free plan, Telegram's
Bot API, the Gmail API and, for the assistant, the free plan of an AI provider (Groq is the default). Inside the
limits of those plans it costs nothing to run, and several limits in the code are there for that: see Known limits.

## What the bot does

A user adds their cards and connects their Gmail. The bot then tells them of each purchase as its alert is read,
with what the card's window comes to so far, and `/spend` shows the totals at any time.

A card's window is its statement cycle or the calendar month. Windows are counted in the user's time zone, which is
Singapore's until they set another with `/timezone`. The bot knows a purchase by the day that it was made, and a
bank counts one by the day that it is posted, usually a day or two later. So a purchase made on the last two days
of a window is counted in the next window, and on those two days a card's current window is the next one. The
window is still shown as the bank has it, and the bot says which days a total counts, and why. A card product can
say otherwise, as the DBS Woman's World Card does: its terms count a purchase by the day that it was made.

### Commands

| Command | What it does |
| --- | --- |
| `/addcard <nickname> <last4> statement <day>` | Tracks a card by statement cycle. `<day>` is the day of the month on which the statement closes. |
| `/addcard <nickname> <last4> calendar` | Tracks a card by calendar month. |
| `/cards` | Lists your cards. |
| `/removecard <nickname>` | Stops tracking a card. |
| `/renamecard <nickname> <new nickname>` | Gives a card another nickname. Nothing else of the card changes. |
| `/spend` | Shows what you have spent on each card in its current window. |
| `/spend <nickname>` | Lists every purchase on one card in its current window, with what they come to. |
| `/best <merchant>` | Says which of your cards to pay with at a merchant: by whether it earns the card's bonus there and what is left of the cap, not by earn rates, which the bot does not know. |
| `/add <nickname> <amount> <merchant>` | Adds a purchase by hand. Its date can go before the merchant. |
| `/remove <purchase id>` | Takes a purchase out. |
| `/products` | Lists the card products whose reward rules are known. |
| `/product <nickname> <product key>` | Links a card to a product. With `none` for the key, it links the card to none. |
| `/sort <nickname>` | Says how a card's purchases are sorted into the reward categories of its product. |
| `/sort <purchase id>` | Shows one purchase with the buttons that move it to another category. |
| `/patterns` | Lists your monthly patterns. |
| `/pattern <nickname> <amount> <merchant>` | Saves what you spend with a card at a merchant in a month. `except <YYYY-MM-DD> ...` after the merchant gives the days on which a charge will not come. |
| `/pattern <nickname> <merchant> none` | Removes a pattern. |
| `/remind <nickname> <day>` | Reminds you of a card's bill at 09:00 on that day of every month, by your time zone, and on the last day of a month that has no such day. With `none` for the day, it removes the reminder. |
| `/timezone` | Shows the time zone that your cards' windows are counted in. |
| `/timezone <name>` | Changes it. The name is an IANA one, such as `Asia/Tokyo`. |
| `/connect` | Connects your Gmail, so that your bank's alerts can be read. |
| `/status` | Says whether your Gmail is connected, and what has been read from it. |
| `/disconnect` | Disconnects your Gmail. |
| `/mcp` | Makes the token with which an AI assistant, such as Claude Code, can read your card totals and purchases. |
| `/mcp revoke` | Takes that access away again. |
| `/delete` | Deletes everything stored about you, once it is sent as `/delete confirm`. |

`/start` sends a welcome and this list, and a command that the bot does not know is answered with the list. A
nickname is 1 to 20 letters, digits, `_` or `-`. `/addcard` takes a product key as a last word, which links the
card as `/product` does. The amount of `/add` can have a currency before it, as in `USD 12.50`, and its date is
written `YYYY-MM-DD`. `/remove` and `/sort` take the id of a purchase, which `/spend <nickname>` shows. The
merchant of `/pattern` is 40 plain characters at most, 3 of them letters or digits at the least, and 12 days can
follow `except`. The bot answers only in a user's own private chat with it.

### Plain messages

A text message that is not a command, and is not the 6-digit code of a sign-in, goes to the bot's assistant, where
the service has an AI provider. A question such as "how much did I spend at the book shop last month?" is answered
in a model's words, from the user's purchases. So is one about what earns a card's bonus, such as "does the OCBC
Rewards Card include MCC 5812?", or about a product's caps and minimum spend, from the rules of the card products
below. A message can also ask for what the commands do, as in "add 5.20 lunch to evol as other spend" or "set my
time zone to Tokyo", and for several things at once. The model only works out what was asked for: the bot's own
code does it, and the reply is the bot's.

What removes or revokes something waits for a tap on "Do it" under the bot's message: taking out a purchase or a
card, disconnecting the Gmail, making or removing the token of `/mcp`, starting a new sign-in, saving or removing
a pattern or a reminder, as one that is saved takes the place of the one that there is, and linking a card to a
product, as that forgets what was marked by hand under another. So does a change that the model asks for after it
has looked purchases up, as a merchant's name is text that somebody else wrote. `/delete` is never done for the
assistant: its user sends `/delete confirm` themselves.

### Photos

Where the service has a model that reads images, a photo of card transactions is read and its purchases are added:
a screenshot from the bank's app, say. The caption can name the card and the category, as in "add these to evol as
other spend". What is clear is added at once. Where the bot cannot tell which card the purchases were made with, or
the model was not sure of an amount or a date, it asks first, with buttons, and waits a day for the answer. A photo
gives 20 purchases at the most, and they count as purchases added by hand. A picture has to be sent as a photo, and
not as a file. The photo is not stored.

### Banks

Alerts are read from three banks, all of Singapore, each for its card transaction alerts: OCBC, UOB and HSBC. Each
has a parser in `src/parsers/`, which names the address that the bank sends its alerts from, and mail from no other
sender is looked for. When a mailbox is connected, the alerts of the 35 days before are read too. The bot tells of
a purchase only when its alert came in the last six hours, so that catching up does not flood the chat. A purchase
is stored even when its card has not been added yet: the bot then says how to add the card.

### Card products

The bot knows the reward rules of four card products. A card that is linked to one has its purchases sorted into
the product's groups, and `/spend <nickname>` then shows each group with its total, its cap and what is left of
the cap. A limit below is the spend in a month that earns the bank's cap on the bonus.

| Key | Product | Groups, with the limit of each | Counted by | Minimum spend |
| --- | --- | --- | --- | --- |
| `uob-evol` | UOB EVOL Card | Online and Mobile Contactless Spend: SGD 300. Selected Gym, Telco and Streaming Spend: SGD 200. Other Spend and Overseas Foreign Currency Spend: no limit. | statement month | SGD 800 |
| `hsbc-revolution` | HSBC Revolution Credit Card | Eligible Transactions: SGD 1,000. Other Transactions: no limit. | calendar month | none |
| `ocbc-rewards` | OCBC Rewards Card | Shopping Spend: SGD 1,110. Other Spend: no limit. | calendar month | none |
| `dbs-womans-world` | DBS Woman's World Card | Online Spend: SGD 1,000. Other Spend: no limit. | calendar month | none |

An alert says neither how a purchase was made nor the category code of its merchant. For the merchants listed in
`src/catalogue/merchants.ts` the code is known, and a purchase there starts where the code puts it on the HSBC,
OCBC and DBS products. For any other merchant on those products, the bot asks two public services that list the
codes of stores, check-mcc.sg and heymax.ai, with the first word of the merchant's name as the purchase is added:
the purchase starts where the code puts it when the merchant's name holds the name of a store that is listed, and
the stores of that name agree. check-mcc.sg comes first: what heymax.ai lists is used only for a merchant that
check-mcc.sg lists no such store for. Any other purchase is taken by its product for one group, which has a cap,
until something says otherwise:

- UOB EVOL Card: a purchase is Online and Mobile Contactless Spend. One in another currency is Overseas Foreign
  Currency Spend, and one at a gym, telco or streaming service that the bank names is Selected Gym, Telco and
  Streaming Spend. One made with the physical card is for its user to mark as Other Spend.
- HSBC Revolution Credit Card: a purchase is an Eligible Transaction. One at a travel agency that the product
  names, such as Trip.com, Agoda or Klook, starts in Other Transactions.
- OCBC Rewards Card: a purchase is Shopping Spend. One with "Shopee Pay" in its merchant's name starts in Other
  Spend, and groceries are for its user to mark as Other Spend.
- DBS Woman's World Card: a purchase is Online Spend. One that the bank's terms take out of online spend by name,
  such as a top-up of YouTrip or EZ-Link, starts in Other Spend. One made in a shop is for its user to mark as
  Other Spend.

A purchase is marked with the "Mark as ..." buttons under the bot's message about it, which `/sort <purchase id>`
shows again. After several purchases are added at once, from a photo or by the assistant, the bot sends that
message for those that neither a rule nor a code placed, on a card whose product sorts by merchant codes: for five
at the most. On such a product, what a purchase is last marked as is remembered for its merchant's name, and the
user's later purchases there that no rule places start in it with no code looked up. `/sort <nickname>` says what
belongs where. Linking a card to another product forgets
the groups that its purchases were marked as by hand, as linking it to none does, and the purchases of its current
window are sorted again by the rules of the new product. The rules are data in `src/catalogue/`, a file to each
product, with the date that the bank's terms are as of and, in a comment, where the bank publishes them.

### Monthly patterns

A pattern is what a user spends with one card at one merchant in a month: one charge, as a gym's, or many small
ones, as bus and train fares. Until it is spent, `/spend <nickname>` holds what is still to come of it back from
what is left of a cap, in a row called `To come`. It counts against the group that a purchase at its merchant
would start in, which the reply to `/pattern` names, and it goes when its card is removed.

At 09:00 on the 1st of a month, by a user's time zone, the bot offers them the spending that looks monthly as
patterns to add. It looks at the two calendar months before, on each card that is linked to a product: a merchant
that the card has a purchase at in both months, in the card's own currency and in a group with a cap, is offered
with what was spent there in the later month, unless one of the card's patterns counts it already, or a pattern for
it would be held against another group than its purchases are in, or than the product's rules put them in. A
merchant is known there by the first word of its name, and by the second too unless that has a digit in it, so
`SAMPLE TRANSIT 4471` and `SAMPLE TRANSIT 9903` are one. Each offer is a message with "Do it" and "Cancel" under it,
five at the most in a month, the largest amounts first. Nothing is saved without a press, and a merchant is offered
for a card once.

## Setting it up

An operator needs a Cloudflare account, a Telegram bot, a Google OAuth client and, for the assistant, a key of an
AI provider. The tools need Node.js 22 or later, and `npm install` brings the wrangler that the commands below run.
The service is deployed from GitHub by a workflow: see Deploying.

### Cloudflare

Create the D1 database with `npx wrangler d1 create spend-tracker`. The command prints the id of the database,
which the deploy needs.

`wrangler.example.jsonc` is the template of the Worker's config. It names the Worker `spend-tracker`, runs the mail
check every minute with a cron trigger, turns Workers Logs on, and binds the database of that name as `DB`. The
real config, `wrangler.jsonc`, is git-ignored, and a deploy makes it from the template. To run wrangler from a
machine of your own, copy the template to `wrangler.jsonc` and add the `database_id` to its D1 entry.

### Settings and secrets

`src/env.d.ts` lists what the Worker reads. Three are plain variables, which a deploy writes into the config from
the repository's secrets of the same names:

- `PUBLIC_BASE_URL`: where the service is reached, with no trailing slash. The sign-in links, the OAuth redirect
  URI and the MCP endpoint that the bot gives out are made from it.
- `OPERATOR_NAME` and `OPERATOR_CONTACT`: who runs the service and how to reach them, as the public pages show.

The rest are secrets of the Worker:

- `TELEGRAM_BOT_TOKEN`: the bot's token.
- `TELEGRAM_WEBHOOK_SECRET`: the secret of the webhook: see The Telegram bot.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: the OAuth client that users sign in to Google through.
- `TOKEN_ENCRYPTION_KEY`: base64 of 32 random bytes, for example from `openssl rand -base64 32`. The tokens that
  read the connected mailboxes are stored encrypted under it. One that was encrypted under another key cannot be
  read, so the key is not to be changed while mailboxes are connected.
- `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` and `AI_VISION_MODEL`, which are optional: see The AI provider.

Set each of them in the Cloudflare dashboard, or with `npx wrangler secret put <NAME> --name spend-tracker`, which
asks for the value. A deploy leaves the secrets as they are. It writes the plain variables anew from its config,
which holds the first three and no others: so the optional AI settings have to be set as secrets too.

### The Telegram bot

Create a bot with @BotFather, which gives its token. Choose a secret for the webhook: Telegram takes 1 to 256
characters in one, each of them a letter, a digit, `_` or `-`. Once the Worker is deployed and has its secrets,
point the bot's webhook at it:

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=<PUBLIC_BASE_URL>/telegram" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Telegram then sends the secret with every update, in the `X-Telegram-Bot-Api-Secret-Token` header, and the Worker
answers 401 to a request that does not bring it. A webhook that is set with a list of `allowed_updates` has to have
`message`, `edited_message` and `callback_query` in that list: without `callback_query` no press of a button
reaches the bot, and without `edited_message` nobody is told that the bot does not read an edited message again.

### The Google OAuth client

In a Google Cloud project, enable the Gmail API and create an OAuth client of the type "Web application". The
client must have `<PUBLIC_BASE_URL>/oauth/callback` registered with Google as a redirect URI. Its id and its secret
are `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The service asks for one permission, which is read-only access
to Gmail (`https://www.googleapis.com/auth/gmail.readonly`). The bot's `/connect` message tells its user to expect
Google's warning that it has not verified the app, and how to go on from it.

### The AI provider

- `AI_API_KEY`: the provider's key. With a key, the assistant is on for every user: there is no switch. With none
  there is no assistant, and no photo is read.
- `AI_BASE_URL`: where the provider's API is reached, with no trailing slash. Left out, it is
  `https://api.groq.com/openai/v1`.
- `AI_MODEL`: the model that is asked there. Left out, it is `openai/gpt-oss-120b`.
- `AI_VISION_MODEL`: the model that reads photos, which is asked at the same address with the same key. Left out,
  it is `qwen/qwen3.8-27b` when `AI_BASE_URL` is left out too, and nothing otherwise: the default is a model of the
  default provider's, and its name means nothing to another. With nothing, the bot reads no photos.

A setting that is left empty counts as one that is not set. Any provider with a chat completions API of the kind
that OpenAI has will do: the bot posts to `<AI_BASE_URL>/chat/completions`, with the key as a bearer token. The
model has to be one that calls tools, and the one for photos has to take images and answer in JSON. Groq's API is
the one that this was written against. The provider must not train its models on what it is sent: see Privacy.

### First deploy

1. Create the database, add the six secrets of the repository that Deploying lists, and push to `main`. The
   workflow applies the migrations and deploys the Worker. It needs none of the Worker's own secrets for that.
2. Set the Worker's secrets, and then the bot's webhook. The bot then answers `/start`.

## Connecting Gmail

A user sends `/connect`. The bot replies with a link to Google sign-in, which works for 10 minutes, and with what
to expect there. The user approves read-only access to their Gmail. That connects nothing by itself: the browser
is then shown a 6-digit code, and the mailbox is connected when the user sends that code in the chat that asked for
the link, within 10 minutes and in five tries. Without that step, somebody could send their own link to another
person and receive that person's bank alerts.

The alerts then start being read within a few minutes. `/status` shows how that goes: when the alerts were last
fully checked, and how many purchases were recorded and how many alerts could not be read in the last 30 days.
When Google ends the access, as it does when the user changes their Google password or removes the access in their
Google Account, the bot says so, and `/connect` connects the Gmail again.

`/disconnect` removes the access and asks Google to revoke it. Revoking ends everything that a Google account has
granted the service, so it is left undone while the mailbox is still connected or being connected from another chat.

## Connecting an AI assistant

A user can let an AI assistant of their own, such as Claude Code, read their card totals and purchases. For that
the service is a remote [MCP](https://modelcontextprotocol.io) server at `<PUBLIC_BASE_URL>/mcp`. It answers a
`POST` and nothing else, and keeps no session. `/mcp` in the bot replies with an access token, and with the command
that adds the server to Claude Code:

```sh
claude mcp add --transport http spend-tracker <PUBLIC_BASE_URL>/mcp --header "Authorization: Bearer <token>"
```

Another assistant is given the same endpoint, with the token in the header `Authorization: Bearer <token>`. The
token is shown that once, and only its SHA-256 hash is stored. Whoever holds it can read that one user's data and
can change nothing. Sending `/mcp` again replaces the token, `/mcp revoke` removes it, and `/delete confirm`
removes it with everything else.

The server has two tools, and both only read:

- `get_spending_summary`: each card's current window, with its total per currency and its number of purchases.
- `list_transactions`: purchases, newest first, each with its id, its time, its card, its amount, its merchant and
  the reward category that it is in. It takes a card's nickname (`card`), where to start and end (`from` and `to`:
  a date, which is a day in the user's time zone, or an instant) and how many to return (`limit`: 50 unless told,
  and 200 at most). Without `from` and `to` it covers the last 30 days. A merchant's name is text taken from an
  email: the tool's description tells the assistant to treat it as data, and never as instructions.

## Privacy

The service serves a page at `<PUBLIC_BASE_URL>` that says what it is and who runs it, and its privacy policy at
`<PUBLIC_BASE_URL>/privacy`. The text of both is in `src/pages.ts`, and the policy is the full account of what is
accessed, what is stored and who else handles it. What it says of the AI provider:

- Nothing is sent to the AI provider unless a user asks a question or, where the bot reads photos, sends a photo.
- With every question go the user's time zone, the day and the time there, the nicknames of their cards and the
  names of the reward categories that their purchases can be sorted into. Details of their purchases are sent only
  as the answering calls for them: the id, the time, the last four digits of the card, the amount, the currency,
  the merchant and the reward category.
- A photo is sent with its caption, with the user's time zone and with the nicknames and category names of their
  cards. The photo is not stored.

Nobody is asked before a question or a photo of theirs is sent, so the bot's welcome says what is sent too. The
policy also says that the text of an email is never stored, and that email data is not used to train AI models:
that holds only with an AI provider that does not train its models on what it is sent.

## Reading the logs

The service writes a line of JSON to its log for most of what it does, and for whatever goes wrong: the name of an
event, and then the fields of that event. This is the line of a run of the mail check that failed when Gmail
answered a listing with a 503:

```json
{"event":"check_failed","stage":"list","user":12,"error":"Error","reason":"http_error","status":503}
```

The line of a failure is written with `console.error`, and every other line with `console.log`. A failure has the
class name of the error (`error`) and, where there is one, why the service raised it (`reason`) and the HTTP status
of the answer that it was raised for (`status`). A line never holds the text of a message, of a question, of an
answer or of an email, a photo or its caption, the name of a merchant, an email address, a Telegram id, the digits
of a card, or a token. `user` is the service's own id of a user, which nobody outside knows them by.

There are two places to read the log:

- The Cloudflare dashboard. Under Workers & Pages, the Worker has an Observability tab, which holds the lines of
  the last few days: the template turns Workers Logs on (`observability`). On the free plan Cloudflare keeps
  200,000 log events a day, each for three days, and the mail check alone writes a line a minute. The fields of a
  line can be filtered by their names, and Cloudflare's own record of each request is in the same view.
- `npm run logs`, which runs `wrangler tail`: the lines of the deployed Worker as they are written, and none from
  before. It needs a `wrangler.jsonc`, which names the Worker.

### The events

`src/log.ts` lists every event with its fields, and with the words that each field can hold.

| Event | What it is |
| --- | --- |
| `check` | A scheduled run of the mail check, as it ends, whether or not it failed: what it listed, read and stored, and how long it took. |
| `check_failed` | A run that failed, with the `stage` that it failed at. It is written before the `check` line of the same run. |
| `access_lost` | A run found that Google no longer honours the token of a mailbox. `told` is whether its user was told. |
| `reminder` | A reminder of a card's bill that a scheduled run had to send, before the `check` line of the same run: `sent`, `blocked` by its chat, which is passed over until the next month, or `failed`. One that could not be sent is tried again ten minutes later while it is still that day for its user. One whose next day could not be worked out, as with a time zone that the Worker does not know, is put off a day. A run that could not look for one has the line with no `user`. |
| `review` | A user's monthly review, which a scheduled run made after its reminder and before its `check` line: `offered`, `nothing` when there was nothing to offer, `blocked` by its chat or `failed`. `offered` is how many patterns it offered. One that was `blocked` or `failed` is not made again that month, and what it had to offer is offered by the next, though some of its messages may have been sent. One whose next 1st could not be worked out, as with a time zone that the Worker does not know, is put off a day. A run that could not look for one has the line with no `user`. A run that only sets when a user is next due, the first time it sees them or after `/timezone`, writes no line. |
| `alert` | An alert that was given to the parser of its bank: `stored`, `duplicate` or `unparsed`. An `unparsed` is what a bank that has changed the wording of its alerts looks like. |
| `mcc_lookup` | A search of one of two services for the category code of a merchant, as a purchase is added: `found` when it listed stores, `none` when it listed none, or `failed`. Both are searched at the same time, so a search writes two lines, each with its `source`: `check-mcc.sg`, which comes first, and `heymax.ai`, whose stores are used only for a merchant that the first lists no store for. One that `failed` was not answered in 2 seconds, or was answered with an error, which is a 429 when check-mcc.sg has had its 100 requests in 15 minutes: the purchase is added all the same, with no category from a code of that service. |
| `connect_link` | `/connect` gave a user a sign-in link. |
| `connect_callback` | Google sent a browser back to `/oauth/callback`, with what came of it. |
| `connect_code` | Six digits were sent in a chat, with whether they connected the mailbox. |
| `disconnect` | `/disconnect` or `/delete confirm` gave up a user's access to their Gmail. |
| `token_revoke` | A token was deleted here: Google revoked it, or was not asked because the same mailbox is still connected or being connected, or could not be told. |
| `webhook_refused` | A request to `/telegram` that was answered 401: it brought no secret, or the wrong one. |
| `update` | An update from Telegram, as the handling of it ends: what `kind` it was, and whether it was `replied` to, `deferred`, `ignored` or `failed`. |
| `question` | A message for the assistant, as its answering ends: what came of it, how the reply was sent, and how many requests it took. |
| `assistant_tool` | One call of a tool by the assistant's model. |
| `action` | One thing that the assistant made out to do, with what came of it. |
| `confirm_press` | A press of "Do it" or "Cancel" under a message that asked before a command was run. |
| `photo` | A photo, as its reading ends: what came of it, and how many purchases were read, stored and held. |
| `held_press` | A press of a button under purchases that the bot asked about before adding them. |
| `telegram_failed` | A request to Telegram that failed, with its `method` and the `status` of the answer. One that Telegram did not answer in 5 seconds has the `error` `TimeoutError`. |
| `ai_call` | A request to the AI provider, however it ended: how long it took, the status of the answer and the provider's count of tokens. |
| `mcp_tool` | A call of a tool through the MCP endpoint. |
| `mcp_refused` | A request to `/mcp` that was turned away before it got to the protocol, with `why`. |

## When a message gets no reply

A message that the bot takes is answered, or its user is told that it was not. A message that is not text gets a
reply that says what the bot reads, and an edited text message one that says it is not read again. When the
handling of a message fails, the chat is told that something went wrong on the bot's side. A question or a photo
is answered at once with a placeholder, which says what to make of it when nothing more comes: the reply is waited
for 27 seconds.

Some updates are passed over on purpose, each with an `update` line that says `ignored` and `why`: among them
whatever is not in its sender's own private chat with the bot, an edit of a message that is not text, and what
Telegram writes in a chat itself when a message is pinned. So a message with no reply at all is one of six things,
which the log tells apart:

- No request came. Telegram posted the Worker nothing, as when the webhook is not set, or its `allowed_updates`
  leaves that kind of update out.
- The request was answered 401, and has a `webhook_refused` line. The webhook was set with another secret than the
  Worker has, or the Worker has none.
- The request came, and left no `update` line. The Worker was ended while it handled the message: a command is
  carried out before the response, and the line is written when that is done.
- The request has an `update` line that says why. One that was `ignored` has `why`. One that `failed` has `told`,
  which is false when the chat could not be told either, and `handled`, which is true when what the message asked
  for had been done all the same. The `telegram_failed` lines before it have what Telegram refused.
- The request has an `update` line that says `deferred`, and no `question` or `photo` line follows it. The Worker
  was ended before the answering was. The placeholder is then still in the chat.
- The request has an `update` line that says `deferred`, and the `question` or `photo` line after it has `sent`
  `none` and `placeholder` false. Telegram took neither the placeholder nor what was to be said after it.

A run that Cloudflare ends early writes no more lines of the service's own. So it shows as a line that is missing:
a minute with no `check` line, or an `update` that was `deferred` with nothing after it.

## Known limits

- The totals are estimates, made of what the banks' alerts say. A purchase that no alert came for, or whose alert
  the parser cannot read, is not counted until it is added by hand, and nothing takes a refund off a total.
- The last two days of a window are counted in the next one, on every card but one of the DBS product, whose terms
  count a purchase by its own day. That a bank counts a purchase by the day that it is posted is from the terms of
  the other three products, and is taken to hold for other cards. The two days are the owner's choice: how long a
  posting takes was not measured.
- A cap counts the card's own currency only. A purchase in another currency is listed and totalled in its own
  currency, is not taken off what is left of a cap, and is left out of the minimum spend: an alert does not say
  what it comes to in the card's currency.
- A product's limits are held against the card's window as the card was added. The terms of the HSBC, OCBC and DBS
  products count by the calendar month, and those of the UOB product by the statement month: a card has to be
  added with `calendar`, or with its statement day, for its limit to be counted as the bank counts it. Nothing
  checks that it was.
- Which group a purchase belongs in is mostly its user's to say: one that no rule places counts against a cap
  until it is marked. The rules are the bank's terms as of the date in the product's file, and no later.
- The limit of the HSBC Revolution Credit Card is that of a cardholder who does not keep SGD 50,000 in an HSBC
  Everyday Global Account: for one who does, the bank's cap comes to SGD 1,200 of spend. Its travel agencies are
  named by card blogs, and not by the bank, which goes by a merchant's category code: the list can fall behind,
  and a charge can carry another code than the list takes it to have.
- The limit of the OCBC Rewards Card is held against the whole amount of each purchase. The bank counts a purchase
  in blocks of S$5 and drops the rest, so what is left of that limit is a little less than what the bank has left.
  The bank's 15X campaign, which has a cap of its own, is not tracked.
- A group that only a rule fills has no button. On the UOB EVOL Card, a purchase that its user moved out of
  Selected Gym, Telco and Streaming Spend, or out of Overseas Foreign Currency Spend, cannot be moved back by hand.
- The service is written inside what the Workers free plan gives one invocation: about 10 ms of CPU time, 50
  outbound requests and 50 database queries. So the mail check, which runs once a minute, checks one mailbox in a
  run and reads one alert at the most. With N mailboxes connected, each has its turn every N minutes: a purchase
  can be told of some minutes after it was made, and a new connection takes a while to get through its 35 days.
  Before it checks the mail, a run sends one reminder that is due, the one that has been due longest, and then
  makes the monthly review of one user, the one whose review has been due longest. So reminders that are due at the
  same time go out a minute apart, and so do reviews.
- A user can have 20 cards and 50 patterns, and can add 100 purchases by hand in 24 hours, those that are read
  from a photo or added by the assistant among them. `/spend <nickname>` lists the latest 200 purchases of a
  window, and still totals them all. What was spent at a pattern's merchant is counted from those 200.
- A purchase that was taken out cannot be put back, and its alert is not read again. It can be added again by hand.
- The assistant does four things for one message at the most, and three when it looked purchases up first. A
  message for it can be 500 characters long, and nothing of an earlier message or answer is kept.
- An answer is a model's, and can be wrong. What the bot's tables show is added up by the service, and is of each
  card's current window only. Any other sum, such as what was spent at one merchant or in an earlier month, is the
  model's own, over the 50 purchases at the most that a listing gives it.
- The AI provider's limits on requests and tokens are those of the whole service, and no user is kept to a share
  of them. On a free plan, which this is built for, a minute of many questions or photos can use them up for
  everybody. The bot then says that the assistant has reached its limit for now.
- The purchases of a photo are a model's reading, and can be wrong. A purchase that the model says it is sure of is
  added with nothing asked, so an amount or a date that it misread is found only by its user. The reading has not
  been tried on a real screenshot, or on a photo of a paper receipt. A photo is read in the largest size that
  Telegram keeps of it within 400 KB.
- A photo that is sent a second time is read as another photo, and its purchases are stored a second time. The bot
  looks for no purchase that is like one that it has, so the same goes for a purchase that an alert has brought
  already. What a user has twice, they take out with `/remove`.
- The default model for photos is one that Groq lists as a preview model, which it may withdraw at short notice.
  The bot then replies to every photo that it could not be read, until `AI_VISION_MODEL` names another model.
- The tables are Telegram rich messages (`sendRichMessage`), which are new. They have not been looked at in
  Telegram's apps: how a table is drawn there, how one that is wider than the screen is shown, and what an app from
  before rich messages shows of one. A reply goes as text only when Telegram answers the rich message with an error.

## Development

```sh
npm install
npm test           # vitest, against a local D1 database with the migrations applied
npm run typecheck  # tsc --noEmit
npm run logs       # wrangler tail: the log of the deployed Worker, as it is written
```

`wrangler.example.jsonc` and `.dev.vars.example` are templates. Their real counterparts, `wrangler.jsonc` and
`.dev.vars`, are git-ignored. The comments in `.dev.vars.example` say what the less obvious settings are. The tests
read `wrangler.example.jsonc` as it is, and no test may reach the network.

## Deploying

A pull request is tested, and merging it into `main` deploys it. Both are the work of `.github/workflows/ci.yml`.
There is no staging environment: what is merged goes live. `wrangler deploy` from a laptop is not how the service
is deployed: it uploads the working folder as it is, committed or not, and applies no migration.

For a pull request, and for a push to `main`, the workflow installs with `npm ci` and runs `npm run typecheck` and
`npm test`. That job is given no secret, so it runs the same for a pull request from a fork. For a push to `main`,
and only once that job has passed, a second job does four things, in this order:

1. It writes `wrangler.jsonc`. The real config is kept out of the repository, so `scripts/deploy-config.mjs` makes
   it from `wrangler.example.jsonc`, with the id of the database and the three `vars` added.
2. It applies the migrations to the live database, with `wrangler d1 migrations apply spend-tracker --remote`.
3. It deploys the code, with `wrangler deploy`. Only the warnings and errors of that are printed (`WRANGLER_LOG`),
   as what wrangler prints besides has the values of the `vars`.
4. It checks the live service: a `GET` of the public URL has to answer 200, and a `POST` to `/telegram` with no
   secret has to answer 401. The second leaves a `webhook_refused` line in the log, with the `why` `no_secret`.

A step that fails fails the run, and nothing after it is done. The migrations come before the code, because code
that is ahead of its database fails at whatever reads or writes what is not there yet. Until the code is deployed,
the code from before runs on the database as the migrations left it: so a migration that takes away what that code
still uses breaks it. The runs of `main` go one at a time, and one that has begun is not cancelled for a later one.

The workflow reads six secrets of the repository, by these names:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token. It has to be allowed to edit Workers scripts, which a deploy
  does, and to edit D1, which applying a migration does, for the one account and no other. In Cloudflare's list of
  permissions those are Workers Scripts and D1 under Account, each set to Edit.
- `CLOUDFLARE_ACCOUNT_ID`: the id of that account.
- `D1_DATABASE_ID`: the id of the D1 database. It becomes the `database_id` of the entry in `d1_databases`.
- `PUBLIC_BASE_URL`: where the service is reached, with no trailing slash. It becomes the var of that name, and it
  is the address that the last step checks.
- `OPERATOR_NAME` and `OPERATOR_CONTACT`: who runs the service and how to reach them. Each becomes the var of its name.

The Worker's own secrets, such as the bot's token, are not among the six: they are set on the Worker, and a deploy
leaves them as they are. The `wrangler` that the workflow runs is a dev dependency, pinned to the version that
`@cloudflare/vitest-plugin` depends on, so the tests and a deploy use the same one. Raise the pin with the plugin.
