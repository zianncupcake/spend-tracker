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
into, an endpoint through which a user's AI assistant can read their totals and purchases, and an assistant of the
bot's own that answers questions asked in plain language.

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

The user is told of a purchase whose alert came less than six hours ago. Older alerts are stored without a message,
so that a new connection catching up does not flood the chat. It is the time the email came that counts, and not
the time of the purchase: a UOB alert states a day and no time, so its purchase can be dated hours before the alert
comes. A purchase is dated by what its alert states, unless that is more than two days from when the email came, or
is a date that does not exist: then it is dated by the email. A merchant's name is text taken from an email, and
Telegram makes a command or a link of whatever looks like one. So the name is sent marked as code, in which nothing
can be tapped. For a card that is linked to a product, the message ends with where the purchase is sorted, and has
the buttons that move it.

The search leaves out any message of 1 MB or more. An alert is a few kilobytes, and a message is parsed whole once
it is fetched, so a huge one with a bank's address on it could take all the CPU time of every run that came upon it.

When Google no longer honours a connection's token, the user is told and the connection is marked as needing to be
reconnected. It is marked only once the message has been sent, so one that fails is sent again on the mailbox's
next turn, unless the user has blocked the bot. `/status` shows how the checking is going. Each run also deletes up
to five sign-ins that were never finished and have expired, and asks Google to revoke any token that one of them
held, with the exception described under Connecting Gmail.

## Purchases one by one

`/spend <nickname>` lists the purchases of a card's current window in a table, from the earliest on: the id of each,
its day, its amount and its merchant, and under them what they come to. A purchase that was added by hand has a `*`
after its id. Amounts are plain numbers under a header that names their currency, and where a table holds more than
one currency each amount has its code.

The reply is one rich message, which Telegram has had since Bot API 10.1 of June 2026 (`sendRichMessage`): a
message of blocks, among which a table is a table, drawn with lines. The heading, and the name over each table, is a
paragraph in bold. The row that names the columns is of header cells. The ids and the amounts are set to the right,
and a row that sums a table up has what it is called in one cell across the columns of the id and the day. A
merchant's name is whole, as a cell wraps what is too long for it. Every text is given as plain text, and the
message is sent with `skip_entity_detection`, so Telegram makes no command and no link of anything in a name.

It lists the latest 200 when a window holds more, and still totals them all. Telegram takes 500 blocks in a rich
message, with the rows of its tables counted among them, and 32,768 characters. A window of 200 purchases comes to
some 230 blocks and rows and, with every merchant's name of the 80 characters that a name can have, to some 20,000
characters.

Rich messages are new, so the bot keeps the same reply as text. When Telegram answers `sendRichMessage` with an
error, the text is sent in its place, and the status of the answer is logged and nothing else. A chat that Telegram
will send nothing to is the exception, as it would take the text no more. As text, a table is a block in letters of
one width (a `pre` entity), with its columns lined up by spaces. Telegram makes nothing to tap of what is in such a
block. No row is longer than 36 characters, which is about what a phone shows across a block: a longer row would
wrap, and its columns would come apart. So a merchant's name is cut short to what the other columns leave it.
Telegram takes 4,096 characters in a message of text, so a long window is sent as several. A table is parted only
between two of its rows, and where it goes on in the next message it has its header again, in a block of that
message's own.

Wherever else the bot shows the id of a purchase, it writes it as `ID 57`. `/sort` and `/remove` take the number
alone, or with a `#` before it.

`/add <nickname> <amount> <merchant>` records a purchase by hand, for a time that no alert covers. A date can go
before the merchant, written `YYYY-MM-DD`. A day of the card's current window, up to today, can be written `D/M` or
`D/M/YY` too. With no year it is the latest such day that is not after today: on 2 January, `30/12` is the 30th of
the December before. Any other `D/M` is read as the start of the merchant's name, so `24/7 Fitness` is a merchant
except while the 24th of July is such a day. Only the first word after the amount is looked at, so a merchant whose
name begins like a date can always be given after a date. A dated purchase is stored at noon of its day in the
user's time zone, or at the time it is added when that day has not got to noon yet. The amount can have a currency
before it, as in `USD 12.50`. Without one it is in the currency of the card's product, or in SGD.

Telegram can deliver a message twice. A purchase added by hand is stored under the id of the message that added it,
so the second delivery stores nothing, and is answered with the purchase as it stands. A user can add 100 purchases
by hand in 24 hours, those taken out since among them: each is a row written, and the database takes only so many
writes in a day. The count is part of the statement that stores a purchase, so no two that come together get past
it.

`/remove <purchase id>` takes a purchase out. Its row is kept and marked, so that the alert it was read from still
counts as known and is never stored again. Whatever totals, lists or counts purchases leaves a marked row out.

## Card products and reward categories

The service knows the reward rules of some card products. They are data, in `src/catalogue/`: a file for each
product, which also says where the bank publishes its terms and what date those terms are as of. So far there is
one, the UOB EVOL Card (`uob-evol`). `/products` lists them, `/product <nickname> <product key>` links a card to one
(`none` in place of the key unlinks it), and `/addcard` takes the key as a last word.

A purchase on a linked card is in one of the product's categories. A product can name one of them as its default:
the category that a purchase is in unless something says otherwise. Two things say otherwise with nobody choosing,
as rules of the product: that the purchase was made in another currency than the product's, and that its merchant's
name holds a name that the product lists. The third is the user, who moves a purchase with a button.

The groups of the UOB EVOL Card are called what the bank's FAQ calls them: Online and Mobile Contactless Spend,
Selected Gym, Telco and Streaming Spend, Other Spend, and Overseas Foreign Currency Spend. A purchase is Online /
Mobile Contactless Spend by default. Online spend and a phone's tap in a shop share one limit, so the two are not
told apart. A purchase in another currency goes under Overseas Foreign Currency Spend, and one at a gym, telco or
streaming service that the bank names goes under Selected Gym, Telco and Streaming Spend. That leaves the user one
thing to do by hand. Other Spend is all other local spend, which is where a purchase made with the physical card
belongs: so the user marks such a purchase as Other Spend, or takes the mark off again.

The bot's message about a purchase has a button for each category that the purchase can be moved to by hand and is
not in already. On the UOB EVOL Card that is "Mark as Other Spend" under a purchase that is Online / Mobile
Contactless Spend, "Mark as Online / Mobile Contactless Spend" under one that is Other Spend, and both under a
purchase that a rule placed. A press moves the purchase, and the message then says where it is and has the buttons
for where it is now. `/sort <purchase id>` shows a purchase with its buttons again. `/sort <nickname>` says how the
card's purchases are sorted and, for this card, that Other Spend is where a purchase made with the physical card
goes: a product can have such a note (`sortingNote`) for what the names of its categories do not say.

Moving one purchase changes no other, and nothing is kept of it for the purchases that come after: a later purchase
at the same merchant starts where the product puts it, as any other does. So a purchase is Other Spend only when its
own button was pressed. Linking a card sorts the purchases of its current window that a rule settles and that no
category is stored for yet.

No category is stored for a purchase that nothing has placed. It is in the default category because that is worked
out whenever the purchase is read, so a purchase that was stored before its card was linked needs no converting. On
a product with no default such a purchase would be not sorted, with a button for every category that can be chosen.

For a linked card, `/spend <nickname>` has a table for each group of the product's categories, in the product's
order, with the purchases that are in the group. A group with no purchases is shown too, so that every limit is
seen: its table is the rows that sum it up, and no others. A table ends with a `Total` row for what the group's
purchases come to. A group with a limit has a `Cap` row for the limit after it, and then a `Left` row for what is
left of the limit or, once nothing is, an `Over` row for how far past it the spend is. The limit is held against
what was spent in the card's own currency, and a group that holds another currency too has a `Total` row for each.
On a product with no default category, what is not sorted has a table of its own after the groups.

After the tables comes how far the spend is towards the product's minimum. Every purchase in the card's own currency
counts towards the minimum. Purchases in other currencies are left out of it, as what they come to in the card's own
currency is not known.

A press of a button reaches the bot as a `callback_query` update. A webhook that was set with a list of
`allowed_updates` has to have `callback_query` in that list. A press is acted on only for a purchase of the user who
pressed, in their own private chat, and what a button sends back is checked as anything else from outside is. A
press for the category that a purchase is in already moves nothing, and is answered and carried through like any
other: it is what comes after Telegram failed to take the edit of an earlier press. So it brings the message up to
date.

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
- `list_transactions`: purchases, newest first, each with its id and the category that it is in on its card's
  product, which is the product's default when no other is stored for it. It takes a card's nickname (`card`), where
  to start and end (`from` and `to`: a date, which is a day in the user's time zone, or an instant) and how many to
  return (`limit`: 50 unless told, and 200 at most). Without `from` and `to` it covers the last 30 days.

A merchant's name is text taken from an email, so it is not to be trusted. It is only ever returned inside a JSON
string, and the tool's description tells the assistant to treat it as data and never as instructions.

The protocol is the work of the official SDK, `@modelcontextprotocol/server`, which is the project's one runtime
dependency. Its handler keeps nothing between requests: there are no sessions, and no stream is held open (a `GET`
is answered 405). It answers the 2026-07-28 revision of the protocol, and the older revisions that open with
`initialize`.

## Asking the bot a question

A text message that is not a command, and is not the 6-digit code of a sign-in, is a question for the bot's
assistant: "how much have I spent on my EVOL card this cycle?", or "what did I buy on 9 October?". The answer is a
model's. The model is told what was asked and is offered the two tools of the MCP server, in the words in which that
server describes them, and it is asked again with what its calls of them came to until it answers. The tools are run
inside the service, by the functions that the MCP endpoint runs and not through it, and whatever they read comes
through the store of the user who asked.

There is no switch. The assistant is on for every user when the service is set up with an AI provider, and a
service with none answers a question by saying that it has no assistant. Three settings make the setup:

- `AI_API_KEY`: the provider's key, which is a secret. With no key there is no assistant.
- `AI_BASE_URL`: where the provider's API is reached, with no trailing slash. Left out, it is
  `https://api.groq.com/openai/v1`.
- `AI_MODEL`: the model that is asked there. Left out, it is `openai/gpt-oss-120b`.

Any provider with a chat completions API of the kind that OpenAI has will do, and it is reached with `fetch`: a
`POST` to `<AI_BASE_URL>/chat/completions` with the key as a bearer token, and with `model`, `messages`, `tools`,
`tool_choice` and `max_completion_tokens` in its body. Groq's is the one that this was written against.

Nobody is asked before a question of theirs is sent to the provider, so a service that has an assistant says what
is sent: in the welcome that answers `/start`, under the list of commands that answers a command that there is not,
and in the privacy policy, which names the details. The provider is sent the question and what the model's calls of
the tools return, and nothing unless a question is asked. The policy also says that what is taken from Gmail is not
used to train AI models, so the provider has to be one that does not train its models on what it is sent.

A model takes seconds over an answer, and Telegram posts an update again when it has waited too long to hear that
the update was taken. So the Worker answers Telegram at once, and the answering goes on in `ctx.waitUntil`. It
first sends the chat the "typing" action, and answers all the same when Telegram does not take that. A Worker is
given 30 seconds after its response, so the provider has 20 seconds for a request and 25 for all the requests of
one question.

A question costs the model four messages at the most: its calls of tools, and then its answer. Six calls of tools
are answered, however many the model makes in one message, and the summary is read once. That keeps a question to
32 database queries at the most, with a request to Telegram for the typing action and one for the answer, or two
when the answer has to be sent again as text. `list_transactions` gives the model 50 purchases at the most, and
says so when a listing is as long as it was let be. What is wrong with a call goes back to the model as the answer
to it, so that it can call again. A question can be 500 characters long.

A user can ask as many questions as they like. The service counts none of them, so the only limit on how many are
answered is the provider's own. The provider takes only so many requests and tokens, from all the users of the
service together: at Groq, for this model when this was written, about 30 requests and 8,000 tokens a minute, and
1,000 requests and 200,000 tokens a day. When it has had as many as it takes, it answers 429, and the bot says that
the assistant has reached its limit for now, and when to try again. For anything else that goes wrong, which a
model that still calls tools in its fourth message is, and one that answers with nothing, it says that the question
could not be answered. Only the status of the provider's answer or the name of the error is logged, and never a
question, an answer or a key.

With a 429, a provider can say how long to wait before it is asked again: Groq does, in a `retry-after` header that
holds a number of seconds. The bot then says when to try again, with the wait rounded up to a unit that a person
would use: "in about a minute" for less than a minute, then so many minutes, as in "in about 12 minutes", and from
an hour on so many hours. With no such header, or with one that is not a number above zero, it says to try again
later.

A merchant's name is text taken from an email. It reaches the model only inside what a tool returns, as a string of
JSON, and the model is told that such text is data and never instructions. The answer can repeat a name, so it is
sent as a rich message of plain paragraphs with `skip_entity_detection`, as `/spend <nickname>` is, and Telegram
makes no command and no link of anything in it. When Telegram answers that with an error, the answer is sent as
text that is all one `code` entity. Either way it is cut to the 4,096 characters of a message of text, and to 500
paragraphs, and what is cut ends with an ellipsis. So does an answer that the model wrote up to its own limit, of
1,024 tokens to a message with those of its reasoning, and no further.

## Known limits

- A purchase message that Telegram fails to accept is not sent again. The purchase is stored all the same, so the
  totals are unaffected.
- A user can have 20 cards at most, and can add 100 purchases by hand in 24 hours at most.
- A button that is pressed twice is carried through twice, as the second press cannot be told from one that is made
  after Telegram failed the first. The purchase is moved once.
- A category that only a rule gives has no button. So a purchase that its user has moved out of one cannot be moved
  back into it by hand.
- A purchase that has been taken out cannot be put back. It can be added again by hand.
- The rich message of `/spend <nickname>` has not been looked at in Telegram's apps: how its tables are drawn there,
  and what an app from before rich messages shows of one. The text is sent in its place only when Telegram answers
  the request with an error, and it has no reason to do that for an app that cannot show the message. The same goes
  for the rich message that an answer of the assistant's is sent as.
- A question is answered on its own. Nothing of an earlier question or of its answer is kept, so one that follows
  on another has to say all of what it asks.
- An answer is a model's, and can be wrong. What a card's window comes to is added up by the service. Any other sum,
  such as what was spent at one merchant, is the model's own, over the 50 purchases at the most that a listing
  gives it.
- The AI provider's limits are those of the whole service, and no user is kept to a share of them. A minute of many
  questions, or of one long one, uses them up for everybody, and so does a day of many. The bot then says that the
  assistant has reached its limit for now, until the provider takes requests again.
- Telegram's reference gives the most that a rich message holds as 32,768 "UTF-8 characters". Should that be a
  count of bytes, 200 purchases whose names are long and in a script of three bytes to a character would come to
  more. Telegram would then answer with an error, and the text would be sent.
- When `/spend <nickname>` is sent as text, a row of a table is kept to 36 characters by counting them. A character
  that is shown wider than a letter, as many emoji and Chinese characters are, can still make its row wrap. Ids and
  amounts are never cut, so a row is longer where they alone come to more, which takes far more digits than the
  purchases on a card have.

## Development

```sh
npm install
npm test           # vitest, against a local D1 database with the migrations applied
npm run typecheck  # tsc --noEmit
```

`wrangler.example.jsonc` and `.dev.vars.example` are templates. Their real counterparts, `wrangler.jsonc` and
`.dev.vars`, are git-ignored. The comments in `.dev.vars.example` say what the less obvious settings are.
