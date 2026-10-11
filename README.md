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
error, the text is sent in its place, and the request that failed is logged with the status of the answer and
nothing of the message. A chat that Telegram will send nothing to is the exception, as it would take the text no
more, and so is a request that Telegram does not answer at all. As text, a table is a block in letters of one width
(a `pre` entity), with its columns lined up by spaces. Telegram makes nothing to tap of what is in such a block. No
row is longer than 36 characters, which is about what a phone shows across a block: a longer row would wrap, and
its columns would come apart. So a merchant's name is cut short to what the other columns leave it. Telegram takes
4,096 characters in a message of text, so a long window is sent as several. A table is parted only between two of
its rows, and where it goes on in the next message it has its header again, in a block of that message's own.

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

A press of a button reaches the bot as a `callback_query` update, and a message as it stands after an edit as an
`edited_message` update. A webhook that was set with a list of `allowed_updates` has to have both in that list, as
well as `message`: without `callback_query` no press reaches the bot, and without `edited_message` no edit does, so
nobody is told that the bot does not read an edited message again. A press is acted on only for a purchase of the
user who pressed, in their own private chat, and what a button sends back is checked as anything else from outside
is. A press for the category that a purchase is in already moves nothing, and is answered and carried through like
any other: it is what comes after Telegram failed to take the edit of an earlier press. So it brings the message up
to date.

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
the update was taken. So the Worker answers Telegram at once, and the answering goes on in `ctx.waitUntil`. A Worker
is given 30 seconds after its response. The provider has 20 of them for a request and 25 for all the requests of one
question, and the bot waits 27 for the reply, counted from when the answering begins. Telegram has 5 seconds for
each request, whoever makes it. A request that it has not answered by then is given up on, so that one request that
is never answered does not hold up all that was to come after it.

The user is not left to wonder in the meantime. The first thing that the answering does is send the chat a
placeholder: "Working on it… If this message is still here in half a minute, something went wrong. Please ask
again." It says what to make of it when nothing more comes, because a Worker that is ended before it is done can
say nothing. Then the chat is shown that the bot is writing, with the "typing" action. Telegram shows that for five
seconds at most, so it is sent again every four, until the reply is made. The question is answered all the same
when Telegram takes neither the placeholder nor the action. The placeholder is waited for, so one that Telegram
does not answer takes its 5 seconds out of the 27. The action is not waited for at all.

An answer is sent as a message of its own, and the placeholder is then deleted: an answer is a rich message, and
Telegram's reference does not say that a message of text can be edited into one. When the placeholder cannot be
deleted, it stays above the answer. Whatever else comes of a question is said in the place of the placeholder,
which is edited to say it: that the assistant has reached its limit, that the question could not be answered, or
that it took too long. It took too long when the provider did not answer a request in the time that the request
had, when the 25 seconds were used up before the model had answered, and when the 27 were over. An answer that
comes after that is sent to nobody. With no placeholder, or with one that Telegram will not have edited, as one that
its user has deleted, the notice is sent as a message of its own.

A chat that Telegram will send nothing to is sent nothing more. Telegram says so with a 403 to the placeholder, to
an answer or to a notice, and when it is the placeholder that it refuses so, the model is not asked at all. A 403 to
the "typing" action stops nothing. An answer that Telegram does not answer at all in its 5 seconds is not sent again
as text, as one that it refuses is: the notice then says that the question could not be answered.

A question costs the model four messages at the most: its calls of tools, and then its answer. Six calls of tools
are answered, however many the model makes in one message, and the summary is read once. That keeps a question to
32 database queries and 4 requests to the provider at the most. It makes 12 requests to Telegram at the most: the
placeholder, the "typing" action 7 times in the 27 seconds, the answer, the answer again as text and, when Telegram
took it neither way, the notice in the place of the placeholder and again as a message of its own. An answer that
Telegram took is followed by one request, which deletes the placeholder. `list_transactions` gives the model 50
purchases at the most, and says so when a listing is as long as it was let be. What is wrong with a call goes back
to the model as the answer to it, so that it can call again. A question can be 500 characters long.

The 27 seconds leave 3 for telling the user what came of the question. That is enough while Telegram answers its
requests, and is not when it answers none: an answer, a notice in the place of the placeholder and a notice as a
message can then take 5 seconds each. So a question whose reply was made late, at a time when Telegram answers
nothing, can run past the 30 seconds. It then has no `question` line in the log, and the `telegram_failed` lines of
the requests that were given up on are what the log has of it.

A user can ask as many questions as they like. The service counts none of them, so the only limit on how many are
answered is the provider's own. The provider takes only so many requests and tokens, from all the users of the
service together: at Groq, for this model when this was written, about 30 requests and 8,000 tokens a minute, and
1,000 requests and 200,000 tokens a day. When it has had as many as it takes, it answers 429, and the bot says that
the assistant has reached its limit for now, and when to try again. For anything else that goes wrong, which a
model that still calls tools in its fourth message is, and one that answers with nothing, it says that the question
could not be answered. Every question has a line in the log when its answering ends, with what came of it and, for
one that was not answered, why. Every request to the provider is logged too, with how long it took and what the
provider counted, and so is every call of a tool: see Reading the logs. A question, an answer or a key never is.

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

## Reading the logs

The service writes a line to its log for most of what it does, and for whatever goes wrong. A line is JSON: the name
of an event, and then the fields of that event. These are two lines of the mail checker. The first is of a run that
stored a purchase and told its user. The second is of a run that failed when Gmail answered a listing with a 503:

```json
{"event":"check","mailbox":true,"user":12,"listed":3,"unknown":1,"headers":1,"read":1,"stored":1,"unparsed":0,"rejected":0,"notified":1,"checked":true,"swept":0,"ms":412}
{"event":"check_failed","stage":"list","user":12,"error":"Error","reason":"http_error","status":503}
```

A Worker's log is what it writes to its console. Cloudflare keeps that when Workers Logs are on for the Worker,
which `"observability": { "enabled": true }` in `wrangler.jsonc` turns on, as the template has it. There are two
places to read it:

- The Cloudflare dashboard. Under Workers & Pages, the Worker has an Observability tab, which holds the lines of the
  last few days. When a message gets no reply, below, says what was seen there and how it is searched.
- `npm run logs`, which runs `wrangler tail`: the lines of the deployed Worker as they are written, and none from
  before.

When this was written, the free plan kept 200,000 log events a day, each for three days. The mail checker writes
one line for a run, which is 1,440 a day, and one more for each alert that it reads. The bot writes one line for an
update. For a question it writes one more when the answering ends, and one for each request to the provider and for
each call of a tool on the way.

The line of a failure is written with `console.error`, and every other line with `console.log`, so that Cloudflare
has a failure at the level of an error and can count it as one. What its dashboard shows of that has not been seen
yet: see When a message gets no reply. A failure has an `error` field too.

### What a line never holds

The service reads people's mail and keeps their purchases, and its log is read by whoever runs it. So a line never
holds:

- the text of a message, of a question or of an answer
- the text or the subject of an email, the name of a merchant, or an email address
- a Telegram user id or chat id, or the digits of a card
- an access token, a refresh token, an API key, or the state or the code of a sign-in
- the message of an error that anything outside the service threw, which can quote what it was given

What a line may hold is the service's own id of a user, names that the code spells out, counts, durations in
milliseconds, HTTP statuses, booleans, and the class name of an error. `user` is that id: the id of the user's row
in the database, which nobody outside the service knows them by.

`src/log.ts` lists every event with its fields, and its types hold the line: a field is a number, a boolean, null
or one of the words that are spelt out for it there, and text that came from outside is none of those. So an event
or a field is added there before anything can log it.

### What Cloudflare keeps besides

Apart from the lines that the service writes, Cloudflare keeps a record of its own of every request. This is what
was seen of such a record in the dashboard on 11 October 2026:

- It holds the address that was requested, with values that look like secrets blanked out. The record of a request
  to `/oauth/callback` had `state=REDACTED` and `code=4%2FREDACTED`.
- It holds the headers of the request, among them `cf-connecting-ip`, `cf-ipcountry`, `user-agent`,
  `accept-language` and `referer`. The record of a request from Telegram had
  `"x-telegram-bot-api-secret-token": "REDACTED"` among them: the secret of the webhook was blanked out, as the
  state and the code of a sign-in were.
- It holds a `cf` object, which was seen to hold `country`, `city`, `postalCode`, `latitude`, `timezone` and `asn`:
  where Cloudflare takes the request to have come from, and by which network.

These records are what When a message gets no reply reads the wall time, the CPU time and the outcome of a run
from. Cloudflare's documentation gives `observability.logs.invocation_logs: false` as the setting that turns them
off. That is from the documentation, and was not tried. The privacy policy says what these records hold of
somebody whose requests come to the service themselves: one who opens a page of it in a browser, or who connects an
AI assistant to it.

### The events

The mail checker:

- `check`: a scheduled run, as it ends, whether or not it failed.
  - `mailbox`: whether a mailbox had its turn. `user`: whose it was, or null.
  - `listed`: how many ids Gmail listed, on all the pages that the run asked for. `unknown`: how many of the ids
    on the page that the run stopped at were new to it.
  - `headers`: how many messages it fetched the headers of. `read`: how many of those it then fetched whole.
  - `stored`: how many purchases it stored. `unparsed`: how many alerts no parser could read. `rejected`: how many
    messages it did not believe to be from a bank.
  - `notified`: how many purchases it told the user of.
  - `checked`: whether the mailbox became fully checked. `swept`: how many expired sign-ins the run cleared away.
    `ms`: how long the run took, in milliseconds.
- `check_failed`: a run that failed. It is written before the `check` line of the same run, and has the fields of a
  failure, which are listed below.
  - `stage`: what the run was doing. `sweep` is clearing away the expired sign-ins, `take` is giving a mailbox its
    turn, and `token` is getting an access token for it. `list` is listing its mail, looking up which of that is
    new, and keeping the token of the page that the next run goes on from. `read` is fetching a message, or its
    headers. `store` is reading the purchase out of an alert and storing it, or noting something else in the
    database: a message that was not stored, that the mailbox is fully checked, or that its connection needs to be
    reconnected. `notify` is telling the user of a purchase, or that the access is lost. To tell of a purchase on
    a card that the user has added, the card's totals are read from the database before Telegram is asked
    anything. So a failure at `notify` that has no `status`, and no `telegram_failed` line before it, is the
    database's and not Telegram's.
  - `user`: whose mailbox it was, or null when none had been given its turn yet.
- `access_lost`: a run found that Google no longer honours the token of a mailbox. `user`: whose it is. `told`:
  whether they were told. A user who has blocked the bot is not, and the connection is marked as needing to be
  reconnected all the same. When the message fails for another reason, the run fails at `notify`, the connection
  is left as it is, and the mailbox's next turn finds the access lost again.
- `alert`: a message that was fetched whole and given to the parser of its bank. `outcome`: `stored`, `duplicate`
  for a purchase that was stored already, or `unparsed` for an email that the parser read no purchase from.
  `parser`: `ocbc` or `uob`, or `example-bank` in the tests. An `unparsed` under the name of a bank's parser is
  what a bank that has changed the wording of its alerts looks like. The parser would be null for an email from no
  bank, and the checker fetches none of those whole.

Connecting Gmail:

- `connect_link`: `/connect` gave a user a link. `user`: whose. The opening of a link is not logged: it changes
  nothing, and anything that previews a link opens it too.
- `connect_callback`: Google sent a browser back to `/oauth/callback`.
  - `outcome`: `code_shown` when the mailbox is held for its code, which the browser was shown. `not_completed`
    when Google sent an error or no code, as it does when the user does not approve. `expired` when the state is
    of no link that works: the link has run out of time, or has been used, or never was one. `replaced` when the
    user asked for a new link while they were at Google. It is written whenever the sign-in was no longer there
    to hold the mailbox, so it is also what a sign-in that ran out of time and was cleared away meanwhile looks
    like, and a `/disconnect` or a `/delete confirm` that was sent meanwhile. `no_gmail_access` when Google did
    not grant the permission to read mail, and `no_lasting_access` when it gave no refresh token. `failed` when
    something went wrong: the line then has `stage`, and the fields of a failure.
  - `stage`: `claim` is claiming the sign-in that the state belongs to, `exchange` is exchanging the code at
    Google, and `profile` is asking Gmail for the address of the mailbox. `hold` is encrypting the token and
    keeping the mailbox for its code. `notify` is telling the chat that the sign-in has finished. The chat is
    looked up in the database first, so a failure there with no `telegram_failed` line before it is the
    database's and not Telegram's.
  - `user`: whose sign-in it was. It is missing from `not_completed`, where none is looked for, and from
    `expired`, where none is found.
- `connect_code`: six digits were sent in a chat. `user`: whose chat it is. `outcome`: `connected`, `wrong` with
  the `tries_left`, `out_of_tries` for the fifth wrong code, `expired` for a code that came too late, or
  `no_attempt` when no sign-in was waiting for a code. With `out_of_tries` and `expired`, the mailbox is let go.
  `expired` is written only while the sign-in is still there. The mail checker clears expired sign-ins away, so
  after about a minute the same late code is a `no_attempt`.
- `disconnect`: `/disconnect`, or `/delete confirm`. `user`: whose. `outcome`: `disconnected`, or `not_connected`
  when there was no connection to remove.
- `token_revoke`: a token was deleted here, and Google was to be asked to revoke it. `outcome`: `revoked`, `kept`
  when it was not asked because the same mailbox is still connected, or being connected, from another chat, or
  `failed` when Google could not be told, with the fields of a failure. A `failed` with `status` 400 is routine:
  Google's documentation says that its revoke endpoint answers 400 for a token that it cannot revoke, which
  includes one that it had already ended. That is from the documentation, and has not been seen here. The line
  names no user. It is written by the request that writes the `connect_link`, `connect_code` or `disconnect` line
  of the user who let the token go, or by the run of the checker that cleared an expired sign-in away.

The bot:

- `webhook_refused`: a request to `/telegram` that was answered 401 for its secret. `why`: `no_secret` when it
  brought none, or `wrong_secret`. When the webhook was set with another secret than the Worker has, every update
  is a `wrong_secret`, and the bot answers nobody.
- `update`: an update that the webhook took, as the handling of it ends. That is before the answering of a
  question begins, which has a line of its own.
  - `kind`: what the update was. A message of text in its sender's own private chat with the bot is a `command`, a
    `question`, or the `code` of a sign-in, sent as six digits. `not_text` is a message there that is not text,
    such as a photo, and `edited` is a message as it stands after an edit. `press` is the press of a button.
    `message` is a message that was ignored before it was read, `other` is an update that holds none of these,
    and `unreadable` is a body that is not JSON.
  - `command`: which command it was, by its name without the slash, as in `spend`. `unknown` is a slash command
    that is none of the bot's, or a message with nothing in it. It is a name from the bot's own list, and never
    what was sent.
  - `outcome`: `replied` when the bot answered: a message with a reply, and a press with what a press is answered
    with. `deferred` for a question that was left to be answered after the response. `ignored`, with `why`.
    `failed` when the handling failed, with `handled`, `told` and the fields of a failure.
  - `why`: why an update was ignored. `not_private`: it was not in a private chat. `not_own_chat`: the private
    chat was not its sender's own, or it did not say who sent it. `no_id`: it was a message or a press without the
    id that Telegram gives one. `not_text`: it was the edit of a message that is not text, as every move of a live
    location is. `service_message`: it was what Telegram writes in a chat itself when a message is pinned there,
    or when the timer that deletes the chat's messages is set. `nothing_read`: it held no message, no edited
    message and no press.
  - `handled`: whether what an update that failed asked for had been done by the time it failed. A message is
    handled once its reply has been made, so that only the sending of the reply was left. `/add` is the exception:
    it is handled once a purchase for its message is stored, by this delivery of the message or by an earlier one,
    whatever failed after that. It is not handled when it stored none, as one past the limit of purchases by hand,
    or when the purchase that an earlier delivery stored has been taken out: `handled` is then false even when
    only the sending of its reply was left. A press is handled once it is to be answered: its purchase has been
    moved by then, or it was found to be a press that moves nothing. `handled` is false for a message that the bot
    does not read, a `not_text` or an `edited`, which asks for nothing but its reply, and for a body that is
    `unreadable`. The order of the lines does not say what `handled` says. A `telegram_failed` line before the
    `update` line is of what the bot was sending when the handling failed, or of the line that was to tell of the
    failure, and an `/add` whose purchase is stored can fail with no such line at all.
  - `told`: whether whoever sent an update that failed was told so: a chat with one line of text, and a press with
    its answer. The line says that something went wrong or, for an `/add` whose purchase is stored, that the
    purchase was stored and that the bot could not reply to it: see When a message gets no reply. `told` is false
    for a chat that Telegram will send nothing to, for a press that had been answered before it failed, and when
    the telling failed too.
  - `ms`: how long the handling took.
- `question`: a question, as its answering ends. That is after the response, so a Worker that is ended before it
  is done writes no such line: see When a message gets no reply.
  - `user`: who asked, or null when the answering ended before their row was read.
  - `outcome`: `answered`. `busy` when the provider had had as many requests as it takes. `failed` when the
    question could not be answered, or its answer could not be sent. `timeout` when time ran out, in one of
    three ways that the fields of the failure tell apart: the `error` `TimeoutError` is a request that the provider
    did not answer in the time that it had, the `reason` `out_of_time` is the 25 seconds of the answering used up,
    and the `reason` `took_too_long` is a reply that was not made in its 27 seconds. `blocked` when Telegram will
    send the chat nothing.
  - `sent`: how the reply reached the chat. `rich` and `text` are an answer, as a rich message or as text. `edit`
    is a notice that was said in the place of the placeholder, and `message` one that was sent as a message of its
    own. `none` is that nothing was said.
  - `placeholder`: whether the placeholder was sent, and Telegram said which message it is. It is false too when
    Telegram took the placeholder and its answer did not hold the id, and when the request was given up on. Either
    way a placeholder may be in the chat, with nothing to edit it or to delete it by.
  - `requests`: how many requests to the provider it took, each of which has an `ai_call` line. A request that was
    still in flight when the 27 seconds ended is counted too, and as a rule has no `ai_call` line: that line is
    written when a request ends, and the Worker does not wait for this one. `tool_calls`: how many calls of tools
    were answered, each of which has an `assistant_tool` line.
  - `ms`: how long it took in all, from before the placeholder was sent.
  - A question that was not answered has the fields of a failure too, which say why. A `failed` with the `error`
    `TimeoutError` is an answer that Telegram did not answer in its 5 seconds, and has a `telegram_failed` line
    before it. A request that the provider did not answer in time is a `timeout`.
- `assistant_tool`: a call of a tool by the model, over a question. These calls are made inside the service and
  not through the MCP endpoint, so they have no `mcp_tool` line. `user`: who asked. `tool`: `get_spending_summary`
  or `list_transactions`, or `unknown` for a tool that there is not, whatever the model called it. `outcome`: `ok`,
  `invalid` when the model was told what was wrong with the call, which a call beyond the six that are answered
  is too, or `failed`, with the fields of a failure. The question then fails with it. `ms`: how long the call took.

Telegram:

- `telegram_failed`: a request to Telegram that failed, whoever made it: the bot, the mail checker or a sign-in.
  It is written whether or not what was being done went on without it, as the answering of a question does when
  the "typing" action is refused. `method`: the method of the Bot API, as in `sendMessage` or `sendChatAction`.
  `status`: the HTTP status of the answer, which is missing when Telegram did not answer. It has the fields of a
  failure: a request that Telegram had not answered in 5 seconds was given up on, and has the `error`
  `TimeoutError`. A request that Telegram takes is not logged: a question makes up to twelve.
  - One refusal by Telegram can be two lines of failure: this one, and the line of what the request was part of,
    which is a `check_failed`, a `connect_callback`, an `update` or a `question` that failed with it. It is one
    failure, and is not to be counted twice.

The AI provider:

- `ai_call`: a request to the provider, however it ended. A question takes four of them at the most.
  - `ms`: how long the request took. `status`: the HTTP status of the answer, which is missing when the provider
    did not answer.
  - `finish`: why the model stopped writing. It is `stop`, `length`, `tool_calls` or `content_filter`, `other` for
    anything else that the answer says, and null when the answer does not say.
  - `tool_calls`: how many tools the model called.
  - `prompt_tokens`, `completion_tokens`, `total_tokens`: the provider's count of the tokens, when it gives one.
  - `retry_after`: how many seconds an answer of 429 said to wait, when it said.
  - A request that failed has the fields of a failure too. One that the provider answered with an error has that
    `status`. One that it did not answer in its 20 seconds has the `error` `TimeoutError`.

The MCP endpoint:

- `mcp_tool`: a call of a tool by a user's AI assistant. `user`: whose token came with it. `tool`:
  `get_spending_summary` or `list_transactions`. `outcome`: `ok`, `invalid` when what the call asked for was
  wrong, which the assistant is told, or `failed`, with the fields of a failure. `ms`: how long the call took. No
  other message of the protocol is logged. Neither is a call that the protocol turns away before it gets to a
  tool: one of a tool that there is not, or with arguments that are not what the tool takes.
- `mcp_refused`: a request to `/mcp` that was turned away before it got to the protocol. `why`: `wrong_origin`
  when it said that it came from a page of another site, which is answered 403. `no_token` when no bearer token
  could be read from it, and `unknown_token` when the token is nobody's: both are answered 401. `wrong_method`
  when it was not a `POST`, which is answered 405.

The line of a failure has up to three fields more:

- `error`: the class name of the error, and nothing else of it. `Error` is the plain one. `TimeoutError` is a
  request that was given up on, and `SyntaxError` an answer that is not JSON. `ChatBlockedError` is Telegram
  refusing to send a chat anything. A name that is not letters alone, or is not text at all, is written as `Error`.
- `reason`: why, for an error that the service raised itself.
  - `http_error`: Google, the AI provider or Telegram answered a request with an error.
  - `grant_lost`: Google no longer honours a refresh token. No line has this reason: the mail checker catches that
    error, and `access_lost` is its line.
  - `page_token`: Gmail did not take the page token that was kept. The next run starts from the first page.
  - `no_access_token`: Google's token endpoint answered with no access token.
  - `no_address`: Gmail's profile of a mailbox held no address.
  - `no_date`: a message from Gmail held no date.
  - `bad_key`: `TOKEN_ENCRYPTION_KEY` is not base64 of 32 bytes.
  - `no_message`: the AI provider's answer held no message.
  - `bad_tool_call`: the AI provider's answer held a call of a tool that cannot be read.
  - `no_user_row`: a user's row was not there after it was inserted.
  - `chat_blocked`: Telegram will not have the chat sent anything: its user has blocked the bot, or their account
    is gone. It answers 403 then.
  - `no_message_id`: Telegram took a message, and its answer did not say which message it is.
  - `out_of_time`: the answering of a question used up its 25 seconds before the model had answered.
  - `no_answer`: the model's message held no answer and called no tool.
  - `still_calling_tools`: the model was still calling tools in its fourth message, which is its last.
  - `took_too_long`: the reply to a question was not made in its 27 seconds.
- `status`: the HTTP status of the answer that the error was thrown for. It is taken from an error only when it is
  a whole number from 100 to 599: any other number that an error holds could be anything, and is not written.

## When a message gets no reply

A message that the bot takes is answered, or its user is told that it was not. A message that is not text is
answered with that the bot only reads text, and a message of text that was edited with that it is not read again.
When the handling of a message fails, the chat is sent one line: "Something went wrong on the bot's side. Please
try again in a moment." That is so whatever failed, the sending of the reply included. No command but `/add` does
harm when it is sent again, and some have to be: the token that `/mcp` makes is nowhere but in its reply, and
neither is the link of `/connect`. `/add` is the exception, from when a purchase for its message is stored.
Whatever fails after that, which is the reading of what its card then comes to or the sending of the reply, the
line is another: "Your purchase was stored, but the bot could not reply to it. Check it with /spend before adding
it again." It does not say to try again, because an `/add` that is sent again is a new message, and stores its
purchase a second time. An `/add` that stored nothing, as one past the limit of purchases by hand, is answered with
the first line, as any other command is. A press of a button that fails before it is answered is answered with
"Something went wrong. Please try again in a moment.", so that the button stops waiting. And a question is answered
with a placeholder before anything else is done about it.

Two things are passed over on purpose: an edit of a message that is not text, and what Telegram writes in a chat
itself when a message is pinned or the timer that deletes messages is set. Both have an `update` line that says
`ignored`. So a message with no reply at all is one of six things, which the log tells apart:

- No request came. Telegram posted the Worker nothing, as when the webhook is not set, or its `allowed_updates`
  leaves that kind of update out.
- The request was answered 401, and has a `webhook_refused` line. The webhook was set with another secret than the
  Worker has.
- The request came, and left no `update` line. The Worker was ended while it handled the message: a command is
  carried out before the response, and the line is written when that is done.
- The request has an `update` line that says why there was no reply. One that was `ignored` has `why`. One that
  `failed` has `told`, which is false when the chat could not be told either, and `handled`, which is true when
  what the message asked for had been done all the same. The `telegram_failed` lines before it have what Telegram
  refused, or did not answer.
- The request has an `update` line that says `deferred`, and no `question` line follows it. The answering of the
  question did not get to its end, as when the Worker is ended before it does. The placeholder is then still in
  the chat, and says what to make of that.
- The request has an `update` line that says `deferred`, and the `question` line after it has `sent` `none` and
  `placeholder` false. Telegram took neither the placeholder nor what was to be said after it, and the
  `telegram_failed` lines between the two have what it refused, or did not answer.

These are three lines of the bot: of a photo that was sent to it, of a question that was answered, and of a command
that failed before its reply was made, with its user told so.

```json
{"event":"update","kind":"not_text","outcome":"replied","ms":310}
{"event":"question","user":12,"outcome":"answered","sent":"rich","placeholder":true,"requests":2,"tool_calls":1,"ms":3412}
{"event":"update","kind":"command","command":"spend","outcome":"failed","handled":false,"told":true,"ms":95,"error":"Error"}
```

What follows was seen in the Cloudflare dashboard on 11 October 2026.

- The Worker has an Observability tab, next to Overview, Metrics and Deployments. Its Events view lists what
  Cloudflare kept, for a time range that is chosen at the top right.
- The search box of that view takes a query language. `$workers.eventType = "fetch"` lists the requests, and
  `$workers.outcome != "ok"` lists the runs that did not end normally.
- Cloudflare splits a line of the service's own into its fields, and the search box takes them by name:
  `event = "check"` listed exactly the lines of the mail checker. This was seen after the lines of the bot were
  deployed.
- The Fields button adds columns, such as `$workers.wallTimeMs` and `$workers.cpuTimeMs`. It can add `event` as a
  column too. A line of the service's own shows nothing in the Level and Message columns of the list.
- An entry opens to its JSON, which has `$workers.outcome` and `$workers.event.response.status`. "View invocation"
  shows the lines of the same request.
- An update that the bot ignored took 1 ms of wall time and 1 ms of CPU. A command took about 800 ms, and 11 to 14
  ms of CPU. A scheduled check took 0.6 to 1.3 s, and 2 to 5 ms of CPU. Wall time counts the work that goes on
  after the response.

What the log cannot show is a run that Cloudflare ends early: such a run writes no more lines of the service's
own. The mail checker writes its `check` line only as a run ends, so a run that was ended early has none. A
question whose answering was ended early has no `question` line after its `update`. The runs that did not end
normally are what `$workers.outcome != "ok"` lists, and such a question is known by an `update` that was `deferred`
with no `question` line after it. A question whose reply was made late, while Telegram answered nothing, ends so
too: see Asking the bot a question. Its `telegram_failed` lines, each with the `error` `TimeoutError`, are in the
log, and its `question` line is not.

Two things were not seen there. A failure has not been seen to be counted as an error, or shown at the level of
one, as nothing has failed since the lines of the bot were deployed. And Cloudflare's documentation calls a run that
its CPU limit ended `exceededCpu`: that is from the documentation, as no such run has been seen.

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
- Several photos or files that are sent together, which Telegram calls an album, come as a message for each of
  them. So an album gets the reply that the bot only reads text once for each of its items.
- An `edited_message` that its user did not make gets the reply that the bot does not read an edited message again.
  Telegram's reference says that such an update can come for a change to a field of a message that a bot does not
  use. This has not been seen.
- After a notice that was said in the place of the placeholder, the chat can go on showing for a few seconds that
  the bot is writing. An edit does not clear that, as a new message does.
- A placeholder that cannot be deleted stays above the answer, and goes on saying that the bot is working on it,
  which is no longer true.
- A request that the bot gave up on after 5 seconds may have been carried out by Telegram all the same, and the bot
  cannot tell. So an answer can be followed by the notice that the question could not be answered, and a notice can
  be in the chat twice. The reply to a command can be followed by the line that says that something went wrong, and
  the reply to an `/add` by the line that says that the bot could not reply to it.
- For the same reason, a sign-in whose notice to the chat Telegram answers late ends on the page that says that the
  sign-in could not be completed, with no code on it, although the chat was told to send the code. The sign-in is
  begun again with `/connect`.
- And the notice that the access to a mailbox was lost is sent again on the mailbox's next turn when Telegram
  answered it late: the connection is marked only once the notice is known to have been sent.

## Development

```sh
npm install
npm test           # vitest, against a local D1 database with the migrations applied
npm run typecheck  # tsc --noEmit
npm run logs       # wrangler tail: the log of the deployed Worker, as it is written
```

`wrangler.example.jsonc` and `.dev.vars.example` are templates. Their real counterparts, `wrangler.jsonc` and
`.dev.vars`, are git-ignored. The comments in `.dev.vars.example` say what the less obvious settings are.
