# spend-tracker

A hosted, multi-user expense tracker. Each user talks to a shared Telegram bot. The service reads the user's bank
transaction-alert emails, extracts each purchase, and keeps a running total per credit card for that card's current
window: its statement cycle or the calendar month. Windows are counted in the user's time zone, which is Singapore's
until they set another with `/timezone`.

The bot knows a purchase by the day that it was made, which is what an alert, a photo or its user gives it. A bank
counts one by the day that it is posted, usually a day or two later. So on every card a purchase made on the last
two days of a window is counted in the next window (`DAYS_COUNTED_IN_NEXT` in `src/domain/window.ts`). For a
statement that closes on the 5th, the statement month of 6 October to 5 November counts the purchases made from 4
October to 3 November. For a calendar month, November counts those made from 30 October to 28 November. And on the
last two days of a window the card's current window is the next one. A product can say another number of days for
its cards (`daysCountedInNext`), and one whose terms count a purchase by the day that it was made says 0: a window
then counts the purchases of its own days, and nothing is said of it. The window is still shown as the bank has it,
every total follows, and nothing that is stored changes. The user is told: the message about a purchase that is
counted in the next window says so and why, `/spend` says under each card which days its total counts and why, and
`get_spending_summary` gives the card `countedFrom`. The rule is from UOB's terms for the EVOL card, which count
spend that is "successfully charged and posted to the Card account in each Statement Month". It is taken to hold
for other cards, and has not been checked for them. The two days are the owner's choice: how long a posting really
takes was not measured.

It runs on Cloudflare Workers with a D1 database.

## Status

Early work. What exists so far: the database schema, the window maths, the Telegram commands, the parsers of bank
alerts, connecting a user's Gmail through Google sign-in, the scheduled check that reads the connected mailboxes,
purchases added and taken out by hand, a catalogue of card products whose reward categories purchases are sorted
into, an endpoint through which a user's AI assistant can read their totals and purchases, an assistant of the
bot's own that answers questions asked in plain language and does what it is asked to do in the same way, and the
adding of the purchases in a photo that a user sends the bot.

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
held, with the exception described under Connecting Gmail. And it deletes the purchases that the bot asked about
and that nobody answered for in a day: see Adding purchases from a photo.

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
it. The purchases that the bot reads from a photo are added by hand in all of this: see Adding purchases from a
photo.

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
assistant: "what did I buy on 9 October?", or "how much did I spend at the book shop last month?". The answer is a
model's. The model is told what was asked and is offered one tool that reads, `find_purchases`, which is the
`list_transactions` of the MCP server under another name. It is asked again with what its calls of the tool came
to until it answers. The tool is run inside the service, by the function that the MCP endpoint runs and not
through it, and whatever it reads comes through the store of the user who asked.

A request to see what was spent is answered with the bot's own tables, and never with text of the model's: "how
much have I spent on my EVOL card this cycle?", or "breakdown of my spending". Such a message asks the bot to do
something: see Asking the bot to do things. The model is offered a tool for it, `show_spending`, which takes a
card's nickname or none, and is told to call it and to write none of the spending out itself. The reply is then
the message that `/spend <nickname>` sends: the purchases of the card's current statement month or calendar month
in tables, with the total of each category and what is left of each limit. With no card named, each card has
such a message of its own, in the order of `/cards`, when the user has five cards at the most. A user with more is
sent the one message that `/spend` sends, with the total of each card: five rich messages are as many as one
message of the user's should set off. And the model is not offered `get_spending_summary`, so that it has no
totals to write out: with them before it, a model was seen to answer in words of its own.

The model is offered `find_purchases` in the words in which the MCP server describes `list_transactions`, with a
few differences. It has a name of its own: as `list_transactions`, a model that was asked to list a user's
transactions was seen to call it first and `show_spending` only after that, which is a request more, and purchases
sent to the provider for nothing. It is said first that the user is shown none of what the tool gives. Its `card`
is not said to be found with `get_spending_summary`, which the model is not offered. A listing is of 50 purchases
at the most. And its schema is no stricter than it has to be: each argument may be null, and nothing says that
the tool takes no other argument. The provider checks a call against the schema that the tool was offered with
before the bot is given the call, and refuses the whole request for one that does not keep to it, so that the
question cannot be answered. It was seen to do so for a null, which a model writes for an argument that it leaves
out. So it is the bot that turns back a call with an argument that the tool has not got: the model is told which
arguments there are, and can call again.

There is no switch. The assistant is on for every user when the service is set up with an AI provider, and a
service with none answers a question by saying that it has no assistant. Four settings make the setup, of which the
last is for photos:

- `AI_API_KEY`: the provider's key, which is a secret. With no key there is no assistant.
- `AI_BASE_URL`: where the provider's API is reached, with no trailing slash. Left out, it is
  `https://api.groq.com/openai/v1`.
- `AI_MODEL`: the model that is asked there. Left out, it is `openai/gpt-oss-120b`.
- `AI_VISION_MODEL`: the model that reads photos, which is asked at the same address with the same key. Left out,
  it is `qwen/qwen3.8-27b` when `AI_BASE_URL` is left out too, and nothing otherwise: the default is a model of the
  default provider's, and its name means nothing to another. With nothing, the bot reads no photos: see Adding
  purchases from a photo.

Any provider with a chat completions API of the kind that OpenAI has will do, and it is reached with `fetch`: a
`POST` to `<AI_BASE_URL>/chat/completions` with the key as a bearer token, and with `model`, `messages`, `tools`,
`tool_choice` and `max_completion_tokens` in its body. Groq's is the one that this was written against.

Nobody is asked before a question of theirs is sent to the provider, so a service that has an assistant says what
is sent: in the welcome that answers `/start`, under the list of commands that answers a command that there is not,
and in the privacy policy, which names the details. The provider is sent the question, what the user's cards are
called and can be sorted into, and what the model's calls of `find_purchases` return, which is purchases, and
nothing unless a question is asked or, where the bot reads photos, a photo is sent. It is sent no total of a card
and nothing of the tables that the bot shows: those are made after the model has had its say, and go to the user
alone. The policy also says that what is taken from Gmail is not used to train AI models, so the provider has to
be one that does not train its models on what it is sent.

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

A question costs the model four messages at the most: its calls of tools, and then its answer. Six calls of the
tool that reads are answered, however many the model makes in one message, and a listing is two database queries.
With the user's row and their cards, which the model is told of before the question, that keeps a question to 14
database queries, and 4 requests to the provider at the most. It makes 12 requests to Telegram at the most: the
placeholder, the "typing" action 7 times in the 27 seconds, the answer, the answer again as text and, when Telegram
took it neither way, the notice in the place of the placeholder and again as a message of its own. An answer that
Telegram took is followed by one request, which deletes the placeholder. `find_purchases` gives the model 50
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

## Asking the bot to do things

A message for the assistant can ask for something to be done: "show me what I spent on evol", "add 5.20 lunch to
evol as other spend", "mark 57 as other spend", "set my time zone to Tokyo". The model works out what the user
asked for, and the bot's own code does it. Beside the one tool that reads, the model is offered four that act:
`show_spending`, `add_purchases`, `set_category` and `run_command`. A call of one does nothing. It ends the
conversation with the model, and comes back from `answerQuestion` as an action (`Action` in
`src/ai/assistant.ts`), which `act` in `src/telegram/handler.ts` carries out with the code that the commands run.
The reply is the bot's too: the model is not asked again, so nothing that a model wrote ever says that something
was done.

What changes nothing, or can be undone in one step, is done at once: showing what was spent, adding purchases,
sorting a purchase into a category, adding a card, linking a card to a product, changing the time zone, and the
commands that only show things. What was spent is shown as `/spend <nickname>` shows it, by `spendDetail`: in a
message for the card that the model named, or in one for each card when it named none and the user has five cards
at the most. A user with more cards is sent the one message that `/spend` sends. Purchases are
added as those of a photo are, by `addRead`, under the id of the message, with the same limit and the same buttons
for what is not clear, and a message has them added once. A purchase is sorted as a press of "Mark as" sorts one,
when it is the user's, its card has a product, and the category is one that can be chosen for that product. A
command is run by `reply`, as if its user had sent the line. Several things in one message are done in their
order, five at the most, each with a reply of its own. When one fails, those before it stay done, and the user is
told that it is those that are answered. When the model asked for more than the assistant handed on, the reply ends
with the line that says that something could not be done. Before the first thing is done, the placeholder is made
to say to check `/spend` before asking again, as that of a photo says: what is done for a message is done again for
one that is sent again. And when the reply cannot be made in its time, or cannot be sent, once the doing has begun,
the notice is "What you asked for may have been done, but the bot could not reply to it. Check /spend before you
ask again."

The commands that are run for the assistant are listed, in `RUN_AT_ONCE` in `src/telegram/handler.ts`: `/addcard`,
`/product` and `/timezone`, and those that only show things, which are `/cards`, `/spend`, `/sort`, `/products`
and `/status`. It is a list of what is run and not of what is not, so that a command which the bot is given later
is run for no model until somebody puts it there. Every line that is of none of these, and is not one that is
asked about first, is answered with that it could not be done: `/start`, `/add`, whose purchases the model gives
with `add_purchases`, the 6-digit code of a sign-in, a command that there is not, and a line that is no command,
which would go to the assistant as a question and be the assistant asking itself.

What removes or revokes waits for one tap: `/remove`, `/removecard`, `/disconnect`, `/mcp`, which replaces the
token that there is, `/mcp revoke`, and `/connect`, which cancels a sign-in that is waiting for its code. None of
these is undone in one step, and a model can make out what nobody asked for: a user who has just approved at Google
and asks whether their Gmail is connected yet is not to have their six digits made useless. So the bot sends a
message that says what would be done and to what, as in "Take this purchase out of ••••5678?" with the purchase
under it, and two buttons, "Do it" and "Cancel". Nothing is done until "Do it" is pressed. The command's own reply
is then sent first, as it can be all that there is of what was done: the token that `/mcp` makes is nowhere else.
After it the press is answered, and the message says "Done." under what it asked and has no buttons. Neither of
those two undoes or hides anything by failing. "Cancel" does nothing, and the message says so.

What the model asks for after a tool has read for it is asked about first too, where it would change something. A
merchant's name is text that somebody else wrote, it reaches the model inside what a tool returns, and a model can
take such text for its user's wish. So purchases that it then gives to be added are held whole, each asked about
with the buttons as one that it was not sure of is, and `/addcard`, `/product` and `/timezone` wait for "Do it" as
the commands that remove do. Sorting is done as before, and so is whatever only shows things.

What deletes everything is never done for the assistant. A line of `/delete`, whatever follows the command, is
answered with what `/delete` answers when it is sent alone, which says to send `/delete confirm`: that is for the
user to send themselves.

The command rides under the two buttons as the line that its user would send, in the 64 bytes that Telegram gives
a button. What a press brings back is what a client sent, which can be anything. So a line in a button's data is
run only when it is again a line of a command that a message can ask about, which are those six and the three that
are asked about after a reading, for the user who pressed, in their own private chat. Any other is answered with
"That button no longer works.": a press cannot delete everything, and cannot run what no button was made for.
Nothing keeps a press from being made twice. The message has no buttons after the first, and a command that is run
again says so itself, as when it is sent twice.

The things of one message may run 30 database queries between them, each counted at the most that it can run: for
spending that is shown, 1 for the cards and then 2 for each card, or 22 for the one message of `/spend`, 8 for an
adding, 1 for the cards and 2 for each purchase that is sorted, 1 for a message that asks, 22 for `/spend` with no
card named, and 6 for any other command. What there is no room left for is not begun, and its user is told to ask
for it again. The answering has run 2 queries by then, for the user and their cards, and 12 more at the most for
the model's calls of `find_purchases`, whether they gave it a listing or were told what was wrong with them.
That is 44 in all, so a request stays inside the 50 that it may run whatever the model does, and whether or not
the tool had read for it.

## Adding purchases from a photo

A photo that a user sends the bot is read for the purchases in it, and they are added: a screenshot of the
transactions in their bank's app, say. The words under the photo, which are its caption, can say which card the
purchases were made with and how they are to be sorted: "add these to evol as bus/mrt physical card".

The reading is a model's, of the provider that answers questions, and there is no switch for it either. A service
reads photos when it is set up with a model that takes images: see `AI_VISION_MODEL` under Asking the bot a
question. A service that has none answers a photo as it answers any attachment, with that the bot only reads text.
One that reads photos answers every other attachment with that it reads text and photos, and that a picture is
read only when it is sent as a photo and not as a file.

The model is sent the photo, its caption, the user's time zone with the day that it is there, and of each of the
user's cards the nickname, the categories that a purchase on it can be put in by hand, and what the card's product
says of the sorting (`sortingNote`). It is asked once, for JSON, and is offered no tools: `src/ai/photo.ts` has the
asking, and the checking of what it answers. Nobody is asked before a photo of theirs is sent to the provider, so a
service that reads photos says what is sent where it says what becomes of a question: in the welcome that answers
`/start`, under the list of commands, and in the privacy policy.

A photo is answered after the response, as a question is, and by the same code: the Worker answers Telegram at
once, the chat gets a placeholder and is shown that the bot is writing, and the reply is waited for 27 seconds. The
placeholder of a photo is its own: "Reading your photo… If this message is still here in half a minute, something
went wrong. Check /spend before you send the photo again." Then come, in this order, the user's row, their cards,
the look whether the message was read before, the photo's file and the reading. A user with no cards is answered
with what `/cards` says of none, and nothing is fetched for them.

Telegram keeps a photo in several sizes. The one that is fetched is the largest that has no more than 400 KB
(`MAX_PHOTO_BYTES` in `src/telegram/handler.ts`): a photo goes to the model as base64 in JSON, and the encoding of
it costs CPU time, of which an invocation has about 10 ms on the free plan. A size that Telegram gives no number of
bytes for is fetched to find out, and no more of it than the 400 KB.

What the bot then does with the purchases that were read:

- The card is the one that the reading took from the caption or, for a user with one card, that card. Otherwise it
  is not known. Neither is it when the caption named a card that the user has not got, whatever cards they have:
  what was said to be on another card is not put on their one card without a word.
- The category of a purchase is the one that the reading took from the caption, when it is one that a user can
  choose on that card. Otherwise the purchase starts where `/add` would start it: where a rule of the card's product
  puts it, or in the product's default.
- What is clear is added at once, with nothing to confirm: with the card known, every purchase that the model was
  sure of.
- What is not clear is asked about first: every purchase whose amount or date the model was not sure of and, with
  the card not known, all of them. They are held as one batch, and shown in a message of their own with buttons.
- A purchase that looks like one that is stored already is added all the same. Nothing is compared, and a user who
  has a purchase twice takes one out with `/remove`.

The purchases are stored as purchases that are added by hand are: under the same parser (`manual`), counted among
the 100 that a user may add by hand in 24 hours, each with an id, and each removable with `/remove`. So each has the
`*` of a purchase added by hand wherever it is listed. A purchase has a day and no time, and is dated as `/add`
dates one that is given with its day: at noon of that day in the user's time zone, or at the time that it is now,
on a day that has not got to its noon yet. It is stored under the id of its message and its place in the reading
(`manual:<message id>:<place>`), so nothing of a message is stored twice.
One statement stores all the purchases of a photo, with the count of the limit as part of it: a photo holds 20
purchases at the most (`MAX_PURCHASES_PER_PHOTO`), and a request may run 50 queries. When the limit leaves some of
them out, they are the last of the photo, and the user is told how many.

A message is read once. Telegram delivers a message again when it has not heard that the message was taken, and a
second reading of a photo can differ from the first, while purchases are stored under their places in the reading.
So before a photo is fetched, the bot looks whether a purchase of its message is stored, at any of the 20 places,
or purchases of it are held. If so, the model is not asked, and the message is answered with one line: "That
message was read already. Look at /spend, and at the bot's earlier messages, for what came of it." A message of
text whose purchases the assistant gave is added from once in the same way: see Asking the bot to do things.

The reply is what was added, in a table like those of `/spend <nickname>`, under a line that names the card and the
category: "Added to evol ••••5678 as Other Spend:". Purchases that are in more than one category have a table to
each. The card that is named is the one that the purchases are stored on. After the tables comes the line that the
reply to `/add` has for where the card then stands. That is one rich message, and is sent as text when Telegram
answers it with an error, as `/spend <nickname>` is. Then, in a message of its own, come the purchases that are
held, each on a line with its merchant marked as code, and under them the buttons. With the card known they are
"Add these 3" and "Skip". With the card not known there is a button for each of the user's cards, as in "Add to
visa", and "Skip", and the purchases that the model was not sure of are marked "not sure". Last, in one message,
comes what else there is to know: how many purchases were not added for the limit, how many could not be read at
all, which `/add` adds by hand, and that only the first 20 of a photo are read.

A purchase is shown with its day and its month, and with its year too when that is not the year that it is now in
the user's time zone, as in "5 Oct 2025": in those tables, and on the lines of the purchases that are held. A photo
mostly shows no year, so the year is the model's to choose, and a purchase that is stored a year too early is in no
window that its card is shown for. The reading doubts a purchase that is dated more than 60 days back, so such a
purchase is asked about first, and its line shows why.

A press of a button under purchases that are held is acted on for the user that they are held for, in their own
private chat, and for nobody else. "Add" stores them, on the card of the button when they were held for none, by
the rules above: the limit, the categories, and the ids that keep a purchase from being stored twice. The message
is then edited to say what was added, with the ids, and has no buttons. "Skip" stores nothing, and the message says
so. Either way the purchases are held no longer. They are let go of last, once the message says what was done: so a
press whose answer or edit Telegram did not take can be made again. The press that is made again can be of another
button, so a press says what is true of the store, whichever button it was. Before it adds or skips, it looks
whether the purchases are stored already. If they are, it stores nothing and skips nothing, and brings the message
up to date with what is stored: "Skip" after an "Add" whose edit failed says that the purchases were added, and
"Add to visa" after "Add to evol" names evol. A press on purchases that are no longer held is answered
with "That button no longer works.": they were answered for, or they were held for more than 24 hours. The
scheduled run deletes those that nobody answered for in that time, with one statement a run, and `/delete confirm`
deletes a user's with everything else. They are in the table `held_batches`, a batch to each message.

Whatever else comes of a photo is said in the place of its placeholder: that no purchases to add were found in it,
that the assistant has reached its limit for now, as a question is told when the provider answers 429, that the
photo took too long to read, that it could not be read, with a clearer photo or `/add` as what to do, and that it
is too large, with to crop it to the purchases.

A photo that is sent again is a new message. It stores its purchases a second time, and those that are held are
then asked about twice, under two messages whose buttons both add them. So from the moment that a purchase of a
photo is stored, or is held, nothing that the bot says of the photo says to send it again. When something fails
after that, or the 27 seconds run out, the user is told: "The purchases in your photo were read, but the bot could
not finish its reply. Check /spend and the bot's other messages before you send the photo again." It says "other"
and not where, as the message that asks about what is held is under the placeholder, which is what says this. It
is what the reply to an `/add` whose purchase is stored does: see When a message gets no reply. The placeholder
says the same, as it is all that is left in the chat when a Worker is ended early. And a reading that comes after
the 27 seconds is stored for nobody: its user has been told by then that the photo took too long, and may have sent
it again.

A photo takes 8 database queries at the most: the user, the cards, the two that look whether the message was read
before, the storing, the look for which purchases the limit left out, the holding, and the card's total. It takes
one request to the provider, and 16 to Telegram at the most: the placeholder, the "typing" action 7 times in the 27
seconds, two for the file, which are where it is and its bytes, the table, the table again as text, the message
that asks, the message of what else there is to know and, when Telegram did not take the last of those, the notice
in the place of the placeholder and again as a message of its own. A press takes 7 queries and 2 requests at the
most.

The table of held purchases is made by `migrations/0009_photos.sql`. A deploy applies the migrations before it
deploys the code: see Deploying. A service whose code is ahead of its database fails at whatever reads or writes
that table, which every photo does. The checking of mail does not fail with it. A run deletes the batches that
nobody answered for once the mailbox has had its turn, in a `try` of its own, so a failure there is logged at a
stage of its own, `batches`, and keeps nobody's mail from being checked.

What is done with a reading knows nothing of photos: `addRead` in `src/telegram/handler.ts` takes the user, their
cards, the reading and the id of the message. So purchases that are read from anything else can be added by the same
code, with the same limit, the same ids and the same buttons.

What was measured, on 11 October 2026, against Groq's `qwen/qwen3.8-27b` with a synthetic screenshot of 720 by 600
pixels that showed five purchases:

- A reading took about one second, and about 1,800 tokens. Every amount, date and merchant was read exactly.
- With a caption that named the card and "bus/mrt physical card", the model took the card and Other Spend from it,
  once the prompt held the product's note on sorting. Without that note it did not.
- The provider's headers gave the model 8,000 tokens a minute and 1,000 requests a day, and its limiter counted
  about 2,500 tokens for one reading. So the service reads about three photos a minute, for all of its users
  together.
- With the prompt as it is now, a synthetic photo of 25 purchases gave the first 20, with `more` set. Every amount
  and date was exact, and two merchant names had a letter wrong. That reading took 2.6 seconds and 2,682 tokens.

Not measured: a real screenshot, a photo of a paper receipt, and the CPU time that a reading costs in production.
And from Groq's documentation, not from anything seen here: the model is a "preview" model, which may be withdrawn
at short notice. A service whose model is withdrawn answers a photo with that it could not be read, until
`AI_VISION_MODEL` names another.

## Reading the logs

The service writes a line to its log for most of what it does, and for whatever goes wrong. A line is JSON: the name
of an event, and then the fields of that event. These are two lines of the mail checker. The first is of a run that
stored a purchase and told its user. The second is of a run that failed when Gmail answered a listing with a 503:

```json
{"event":"check","mailbox":true,"user":12,"listed":3,"unknown":1,"headers":1,"read":1,"stored":1,"unparsed":0,"rejected":0,"notified":1,"checked":true,"swept":0,"batches":0,"ms":412}
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
each call of a tool on the way, and one for each thing that the assistant made out to do. For a photo it writes one
more when the reading ends, and one for the request to the provider. And for a press of a button under purchases
that it asked about, or under a message that asked before a command was run, it writes one more.

The line of a failure is written with `console.error`, and every other line with `console.log`, so that Cloudflare
has a failure at the level of an error and can count it as one. What its dashboard shows of that has not been seen
yet: see When a message gets no reply. A failure has an `error` field too.

### What a line never holds

The service reads people's mail and keeps their purchases, and its log is read by whoever runs it. So a line never
holds:

- the text of a message, of a question or of an answer
- a photo or any byte of one, the caption under one, or the id that Telegram knows a file by
- the text or the subject of an email, the name of a merchant, or an email address
- a Telegram user id or chat id, or the digits of a card
- an access token, a refresh token, an API key, or the state or the code of a sign-in
- the message of an error that anything outside the service threw, which can quote what it was given

What a line may hold is the service's own id of a user, names that the code spells out, counts, durations in
milliseconds, HTTP statuses, booleans, and the class name of an error. How many bytes a photo has is a count.
`user` is that id: the id of the user's row in the database, which nobody outside the service knows them by.

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
    `batches`: how many batches of held purchases it deleted, which nobody had answered for in the 24 hours that
    one is held: see Adding purchases from a photo. `ms`: how long the run took, in milliseconds.
- `check_failed`: a run that failed. It is written before the `check` line of the same run, and has the fields of a
  failure, which are listed below.
  - `stage`: what the run was doing. `sweep` is clearing away the expired sign-ins. `batches` is deleting the held
    purchases that nobody answered for, which is done once the mailbox has had its turn: a failure there ends
    nothing else, so a run can have a line of it after the line of a failure at another stage, and it names no
    user. `take` is giving a mailbox its turn, and `token` is getting an access token for it.
    `list` is listing its mail, looking up which of that is new, and keeping the token of the page that the next
    run goes on from. `read` is fetching a message, or its headers. `store` is reading the purchase out of an
    alert and storing it, or noting something else in the database: a message that was not stored, that the
    mailbox is fully checked, or that its connection needs to be reconnected. `notify` is telling the user of a
    purchase, or that the access is lost. To tell of a purchase on a card that the user has added, the card's
    totals are read from the database before Telegram is asked anything. So a failure at `notify` that has no
    `status`, and no `telegram_failed` line before it, is the database's and not Telegram's.
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
  question begins, and before the reading of a photo, each of which has a line of its own.
  - `kind`: what the update was. A message of text in its sender's own private chat with the bot is a `command`, a
    `question`, or the `code` of a sign-in, sent as six digits. `photo` is a photo there, on a service that reads
    photos. `not_text` is any other message there that is not text, such as a voice message, and a photo on a
    service that reads none. `edited` is a message as it stands after an edit. `press` is the press of a button.
    `message` is a message that was ignored before it was read, `other` is an update that holds none of these,
    and `unreadable` is a body that is not JSON.
  - `command`: which command it was, by its name without the slash, as in `spend`. `unknown` is a slash command
    that is none of the bot's, or a message with nothing in it. It is a name from the bot's own list, and never
    what was sent.
  - `outcome`: `replied` when the bot answered: a message with a reply, and a press with what a press is answered
    with. `deferred` for a question that was left to be answered after the response, and for a photo that was left
    to be read then. `ignored`, with `why`. `failed` when the handling failed, with `handled`, `told` and the
    fields of a failure.
  - `why`: why an update was ignored. `not_private`: it was not in a private chat. `not_own_chat`: the private
    chat was not its sender's own, or it did not say who sent it. `no_id`: it was a message of text, a photo or a
    press without the id that Telegram gives one. `not_text`: it was the edit of a message that is not text, as
    every move of a live location is, and as a photo is whose caption was changed. `service_message`: it was what
    Telegram writes in a chat itself when a message is pinned there, or when the timer that deletes the chat's
    messages is set. `nothing_read`: it held no message, no edited message and no press.
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
  - `outcome`: `answered`. `acted` when the assistant made out things to do, and the replies to them were sent:
    each of them has an `action` line, which says what came of it. `busy` when the provider had had as many
    requests as it takes. `failed` when the question could not be answered, or its answer could not be sent.
    `timeout` when time ran out, in one of three ways that the fields of the failure tell apart: the `error`
    `TimeoutError` is a request that the provider did not answer in the time that it had, the `reason`
    `out_of_time` is the 25 seconds of the answering used up, and the `reason` `took_too_long` is a reply that was
    not made in its 27 seconds. `blocked` when Telegram will send the chat nothing.
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
  - `actions`: how many things the assistant made out to do. It is missing from a question that was answered. A
    `failed` or a `timeout` that has it is of a message whose reply could not be sent or made in time once the
    doing had begun: its user was told to check `/spend` before asking again.
  - `ms`: how long it took in all, from before the placeholder was sent.
  - A question that was not answered has the fields of a failure too, which say why. A `failed` with the `error`
    `TimeoutError` is an answer that Telegram did not answer in its 5 seconds, and has a `telegram_failed` line
    before it. A request that the provider did not answer in time is a `timeout`.
- `assistant_tool`: a call of a tool by the model, over a question. These calls are made inside the service and
  not through the MCP endpoint, so they have no `mcp_tool` line. `user`: who asked. `tool`: `find_purchases`,
  one of the four that act, which are `show_spending`, `add_purchases`, `set_category` and `run_command`, or
  `unknown` for a tool that there is not, whatever the model called it: the two names of the MCP server's tools
  are such, as the model is offered neither. `outcome`: `ok`, `invalid` when the model was told what was wrong
  with the call, which a call beyond the six that are answered is too, or `failed`, with the fields of a failure.
  The question then fails with it. `ms`: how long the call took.
- `action`: one thing that the assistant made out to do, as the bot is done with it: see Asking the bot to do
  things. It is written before the `question` line of its message. `user`: who asked.
  - `kind`: `show` for spending to show, `add` for purchases to add, `category` for purchases to sort, `command`
    for a command to run.
  - `command`: which command, for a `command`, by its name in the bot's own list, and never what the model wrote.
    `unknown` is a line of no command of the bot's.
  - `outcome`: `done`. `asked` when nothing is done until its user presses a button: a command that removes or
    revokes, an adding of which every purchase is held and, after a tool had read for the model, a command that
    changes something. `refused` when the bot did nothing of it: `/delete`, a line of no command that is run for
    the assistant, a command that is asked about and has nothing to act on, spending to show for a user who has no
    cards, purchases of which none could be sorted, and purchases to add that there were none of, or that their
    message had added already. `failed`, with the fields of a failure, which ends the doing: every action after it
    is `skipped`, as every action is that there was no room left for.
  - `stored`, `held`: how many purchases an `add` stored at once, and how many it holds.
- `confirm_press`: the press of "Do it" or "Cancel" under a message that asked before a command was run. It is
  written before the `update` line of the press. `user`: who pressed. `command`: which command the button's line
  is of, out of those that a message can ask about: `remove`, `removecard`, `disconnect`, `mcp`, `connect`,
  `addcard`, `product` and `timezone`. `outcome`: `done` when the command was run, `cancelled`, or `refused` for a
  press that brought a line of no such command, which has no `command` and is answered with that its button no
  longer works. A press by somebody whom nothing is stored about has no such line. A `done` is written once the
  command has run, before its reply is sent: a `telegram_failed` line after it is of the reply, of the answer to
  the press or of the edit, and only the first of those fails the press.
- `photo`: a photo, as its reading ends. That is after the response, as with a question, so a Worker that is ended
  before it is done writes no such line.
  - `user`: whose photo it was, or null when the reading ended before their row was read.
  - `outcome`: `read` when purchases were read from it, and their user was told what came of them: the counts say
    what that was. `nothing` when no purchases to add were found in it, and `no_cards` when its user has no cards.
    `repeated` when its message was read before, so that it was not fetched or read again: Telegram delivered it a
    second time. `too_large` when it has more than 400 KB in every size, or its file turned out to have. `busy`
    when the provider had had as many requests as it takes. `timeout` when time ran out: the `error` `TimeoutError`
    is a request that the provider did not answer in the time that it had, and the `reason` `took_too_long` is a
    reply that was not made in its 27 seconds. `failed` when the photo could not be read, or what came of it could
    not be stored or sent. `blocked` when Telegram will send the chat nothing.
  - `sent`: how the reply reached the chat. `rich` is a reply whose table went as a rich message. `text` is one
    that went as text and nothing else: its table did, or it had none, as when every purchase is asked about.
    `edit` is a notice that was said in the place of the placeholder, and `message` one that was sent as a message
    of its own. `none` is that nothing was said.
  - `placeholder`: whether the placeholder was sent, and Telegram said which message it is: as for a question.
  - `bytes`: how many bytes the file that was fetched has, or 0 when none was fetched.
  - `requests`: how many requests to the provider the reading took, which is one, or none. It has an `ai_call`
    line.
  - `read`: how many purchases the reading gave that passed its checks, 20 at the most. `unreadable`: how many it
    gave that failed them, and were left out.
  - `stored`: how many purchases were stored at once. `held`: how many are held, for their user to answer for.
    What `read` has beyond the two was left out for the limit on purchases by hand, or was stored by an earlier
    delivery of the same message, which a `stored` of 0 beside a `read` of more is the mark of.
  - `ms`: how long it took in all, from before the placeholder was sent.
  - A photo that nothing was added from for a reason of the service's or the provider's has the fields of a
    failure too: a `busy`, a `timeout`, a `failed` and a `blocked`. A `failed` or a `timeout` whose `stored` or
    `held` is above 0 is of a photo whose purchases were stored or held before it failed: its user was told that
    they were read, and was not told to send it again.
- `held_press`: the press of a button under purchases that are held. It is written before the `update` line of
  the press. `user`: who pressed. `outcome`: `added`, `skipped`, or `refused` for a press that was answered with
  that its button no longer works: the purchases are held no longer, or are held for somebody else, or the press
  brought what no button under them holds. `held`: how many purchases were held for the press to add or to skip,
  which is 0 for one that was refused. `stored`: how many of them the press stored, which is fewer when the limit
  on purchases by hand left some out, and 0 when an earlier press had stored them already: such a press is `added`
  whichever button it was, as it stores nothing, skips nothing and has the message say what is stored. A press by
  somebody whom nothing is stored about has no such line.

Telegram:

- `telegram_failed`: a request to Telegram that failed, whoever made it: the bot, the mail checker or a sign-in.
  It is written whether or not what was being done went on without it, as the answering of a question does when
  the "typing" action is refused. `method`: the method of the Bot API, as in `sendMessage` or `sendChatAction`.
  The fetching of a photo's file is two requests: `getFile` is the asking where the file is, and `downloadFile`,
  which is no method of the API, is the fetching of its bytes.
  `status`: the HTTP status of the answer, which is missing when Telegram did not answer. It has the fields of a
  failure: a request that Telegram had not answered in 5 seconds was given up on, and has the `error`
  `TimeoutError`. A request that Telegram takes is not logged: a question makes up to twelve.
  - One refusal by Telegram can be two lines of failure: this one, and the line of what the request was part of,
    which is a `check_failed`, a `connect_callback`, an `update` or a `question` that failed with it. It is one
    failure, and is not to be counted twice.

The AI provider:

- `ai_call`: a request to the provider, however it ended. A question takes four of them at the most, and the
  reading of a photo takes one.
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
  - `took_too_long`: the reply to a question, or what came of a photo, was not made in its 27 seconds.
  - `file_too_large`: a file that Telegram holds has more bytes than the bot fetches of one. No line has this
    reason: the bot catches that error, and the `photo` line with the outcome `too_large` is its line.
  - `not_json`: the model that read a photo answered with what is not JSON.
  - `bad_reading`: what that model answered is not of the shape that it was asked for, or Telegram's answer to
    `getFile` did not say where the file is.
- `status`: the HTTP status of the answer that the error was thrown for. It is taken from an error only when it is
  a whole number from 100 to 599: any other number that an error holds could be anything, and is not written.

## When a message gets no reply

A message that the bot takes is answered, or its user is told that it was not. A message that the bot does not
read is answered with what it reads, which is text or, on a service that reads photos, text and photos. A message
of text that was edited is answered with that it is not read again.
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
with a placeholder before anything else is done about it, as a photo is. A photo whose purchases are stored or held
is not to be sent again either, and what its user is told when something fails after that says so: see Adding
purchases from a photo. The same goes for a message that the assistant did things for: see Asking the bot to do
things.

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
- The request has an `update` line that says `deferred`, and no `question` line follows it or, for a photo, no
  `photo` line. The answering of the question, or the reading of the photo, did not get to its end, as when the
  Worker is ended before it does. The placeholder is then still in the chat, and says what to make of that.
- The request has an `update` line that says `deferred`, and the `question` or `photo` line after it has `sent`
  `none` and `placeholder` false. Telegram took neither the placeholder nor what was to be said after it, and the
  `telegram_failed` lines between the two have what it refused, or did not answer.

These are five lines of the bot: of a voice message that was sent to it, of a question that was answered, of a
command that failed before its reply was made, with its user told so, of a photo of which three purchases were added
and two are asked about, and of the press of the button that added those two.

```json
{"event":"update","kind":"not_text","outcome":"replied","ms":310}
{"event":"question","user":12,"outcome":"answered","sent":"rich","placeholder":true,"requests":2,"tool_calls":1,"ms":3412}
{"event":"update","kind":"command","command":"spend","outcome":"failed","handled":false,"told":true,"ms":95,"error":"Error"}
{"event":"photo","user":12,"outcome":"read","sent":"rich","placeholder":true,"bytes":96412,"requests":1,"read":5,"unreadable":0,"stored":3,"held":2,"ms":2140}
{"event":"held_press","user":12,"outcome":"added","held":2,"stored":2}
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
question whose answering was ended early has no `question` line after its `update`, and a photo whose reading was
ended early has no `photo` line. The runs that did not end normally are what `$workers.outcome != "ok"` lists, and
such a question or photo is known by an `update` that was `deferred` with no line of its own after it. A question
whose reply was made late, while Telegram answered nothing, ends so too: see Asking the bot a question. Its
`telegram_failed` lines, each with the `error` `TimeoutError`, are in the log, and its `question` line is not.

Two things were not seen there. A failure has not been seen to be counted as an error, or shown at the level of
one, as nothing has failed since the lines of the bot were deployed. And Cloudflare's documentation calls a run that
its CPU limit ended `exceededCpu`: that is from the documentation, as no such run has been seen.

## Known limits

- A purchase message that Telegram fails to accept is not sent again. The purchase is stored all the same, so the
  totals are unaffected.
- A user can have 20 cards at most, and can add 100 purchases by hand in 24 hours at most, those that the bot reads
  from a photo among them.
- A button that is pressed twice is carried through twice, as the second press cannot be told from one that is made
  after Telegram failed the first. The purchase is moved once.
- A category that only a rule gives has no button. So a purchase that its user has moved out of one cannot be moved
  back into it by hand.
- A purchase that has been taken out cannot be put back. It can be added again by hand.
- The rich message of `/spend <nickname>` has not been looked at in Telegram's apps: how its tables are drawn there,
  and what an app from before rich messages shows of one. The text is sent in its place only when Telegram answers
  the request with an error, and it has no reason to do that for an app that cannot show the message. The same goes
  for the rich message that an answer of the assistant's is sent as, and for the one that tells of the purchases
  that were added from a photo.
- A question is answered on its own. Nothing of an earlier question or of its answer is kept, so one that follows
  on another has to say all of what it asks.
- An answer is a model's, and can be wrong. What a card's window comes to is added up by the service. Any other sum,
  such as what was spent at one merchant, is the model's own, over the 50 purchases at the most that a listing
  gives it.
- The AI provider's limits are those of the whole service, and no user is kept to a share of them. A minute of many
  questions, or of one long one, uses them up for everybody, and so does a day of many. The bot then says that the
  assistant has reached its limit for now, until the provider takes requests again. The model that reads photos
  has limits of its own, which about three photos in a minute use up.
- The purchases of a photo are a model's reading, and can be wrong. A purchase that the model says it is sure of is
  added with nothing asked, so an amount or a date that it misread is found only by its user, in the table of what
  was added. The reading has not been tried on a real screenshot, or on a photo of a paper receipt.
- A photo that is sent a second time is read as another photo, and its purchases are stored a second time. The bot
  looks for no purchase that is like one that it has, so the same goes for a purchase that an alert of the bank's
  has brought already. What a user has twice, they take out with `/remove`.
- A message that was read is not read again, which the bot knows by a purchase of it that is stored or by purchases
  of it that are held. Two deliveries of one message that are in flight together can each look before the other
  has stored or held anything, and both are then read. What keeps them from storing a purchase twice is the
  purchase's place in the reading, and a model can read the two differently, a photo or the words of a message:
  the purchases in another order, or one more or one less. A purchase can then be stored twice, or be left out.
  Telegram delivers a message again when it has not heard that the message was taken, and the Worker tells it so
  before a photo is read or a question is answered.
- A purchase is put on a card that its user's words name, and the bot does not weigh what the words say of it. The
  card is kept when the model gives it and its nickname stands in the caption or the message as a word. So "these
  are not on evol" names evol, and when the model gives evol for it, the purchases are added to evol.
- The look that a press of a button under held purchases takes at what is stored is not one step with what it then
  does. Two different buttons that are pressed at the same moment can each find nothing stored: "Skip" and "Add"
  then leave the message saying whichever of the two was said last, though the purchases are stored.
- A purchase that was read from a photo has a day and no time. It is dated as `/add` dates one that is given with a
  date: at noon of that day in its user's time zone, or at the time that it is now, on a day that has not got to
  its noon yet.
- The assistant sorts 14 purchases for one message at the most, and fewer when the message asks for other things
  too: each takes two database queries. The model is told that it may give 20.
- The tables that the assistant shows are of each card's current statement month or calendar month, and of
  nothing else. What was spent in an earlier month, or at one merchant, is still answered in the model's words,
  from the purchases that `find_purchases` gives it. So is a message that the model does not take for a
  request to see what was spent, though it is one: which of the two a message is, is the model's to make out.
- A message for the assistant that Telegram delivers again is answered again: the model is asked a second time,
  and what it then makes out is done a second time. Purchases are added from a message once all the same, and a
  second doing of anything else that the bot does at once leaves it as it was, or says that it is done.
- A picture that is sent as a file is not read: only one that is sent as a photo is. And a photo is not read again
  when its caption is edited, which is passed over with nothing said.
- When Telegram does not take the edit of the message that asked about held purchases, that message goes on asking,
  with its buttons, though the purchases were added or skipped. The next press of one of its buttons brings it up
  to date. When that press comes after the 24 hours, it is answered with that the button no longer works.
- Telegram's reference gives the most that a rich message holds as 32,768 "UTF-8 characters". Should that be a
  count of bytes, 200 purchases whose names are long and in a script of three bytes to a character would come to
  more. Telegram would then answer with an error, and the text would be sent.
- When `/spend <nickname>` is sent as text, a row of a table is kept to 36 characters by counting them. A character
  that is shown wider than a letter, as many emoji and Chinese characters are, can still make its row wrap. Ids and
  amounts are never cut, so a row is longer where they alone come to more, which takes far more digits than the
  purchases on a card have.
- Several photos or files that are sent together, which Telegram calls an album, come as a message for each of
  them, and only one of those messages has the caption. On a service that reads photos, each photo of an album is
  read on its own: the one with the caption goes by it, and each of the others is read as a photo with no caption,
  so a user with more than one card is asked which card its purchases were made with. An album of anything else,
  and one of photos on a service that reads none, gets the reply that says what the bot reads once for each of its
  items.
- An `edited_message` that its user did not make gets the reply that the bot does not read an edited message again.
  Telegram's reference says that such an update can come for a change to a field of a message that a bot does not
  use. This has not been seen.
- After a notice that was said in the place of the placeholder, the chat can go on showing for a few seconds that
  the bot is writing. An edit does not clear that, as a new message does.
- A placeholder that cannot be deleted stays above the answer, and goes on saying that the bot is working on it,
  which is no longer true. The placeholder of a photo stays above what was added from it in the same way.
- A request that the bot gave up on after 5 seconds may have been carried out by Telegram all the same, and the bot
  cannot tell. So an answer can be followed by the notice that the question could not be answered, and a notice can
  be in the chat twice. The reply to a command can be followed by the line that says that something went wrong, and
  the reply to an `/add` by the line that says that the bot could not reply to it. The table of what was added from
  a photo can be followed by the line that says that its purchases were read and that the bot could not finish its
  reply.
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

## Deploying

A pull request is tested, and merging it into `main` deploys it. Both are the work of `.github/workflows/ci.yml`.
There is no staging environment: what is merged goes live. `wrangler deploy` from a laptop is no longer how the
service is deployed. It uploads the working folder as it is, committed or not, and applies no migration, so what
was live was often not what `main` had.

For a pull request, and for a push to `main`, the workflow installs with `npm ci` and runs `npm run typecheck` and
`npm test`. That job is given no secret, so it runs the same for a pull request from a fork. For a push to `main`,
and only once that job has passed, a second job does four things, in this order:

1. It writes `wrangler.jsonc`. The real config is kept out of the repository, so `scripts/deploy-config.mjs` makes
   it from `wrangler.example.jsonc`, with the id of the database and the three `vars` added. What is deployed is
   the template with those four values, so the two cannot drift.
2. It applies the migrations to the live database, with `wrangler d1 migrations apply spend-tracker --remote`.
3. It deploys the code, with `wrangler deploy`. Only the warnings and errors of that are printed (`WRANGLER_LOG`),
   as what wrangler prints besides has the values of the `vars`.
4. It checks the live service: a `GET` of the public URL has to answer 200, and a `POST` to `/telegram` with no
   secret has to answer 401. The second leaves a `webhook_refused` line in the log, with the `why` `no_secret`.

A step that fails fails the run, and nothing after it is done. The migrations come before the code because code
that is ahead of its database fails at whatever reads or writes what is not there yet: without the table of held
purchases, every photo fails, and every scheduled run fails at its stage `batches`. A table that no code uses yet
is in nobody's way. But until the code is deployed, and for as long as a deploy fails after its migrations, the
code that is live is the one from before, on the database as the migrations left it. So a migration that takes
away what that code still uses breaks it.

The runs of `main` go one at a time, and a run that has begun is not cancelled for a later one, so a deploy is not
cut off between its migrations and its code.

The workflow reads six secrets of the repository, by these names:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token. It has to be allowed to edit Workers scripts, which a deploy
  does, and to edit D1, which applying a migration does, for the one account and no other. In Cloudflare's list of
  permissions those are Workers Scripts and D1 under Account, each set to Edit.
- `CLOUDFLARE_ACCOUNT_ID`: the id of that account.
- `D1_DATABASE_ID`: the id of the D1 database. It becomes the `database_id` of the entry in `d1_databases`.
- `PUBLIC_BASE_URL`: where the service is reached, with no trailing slash. It becomes the var of that name, and it
  is the address that the last step checks.
- `OPERATOR_NAME`: who runs the service, as the public pages name them. It becomes the var of that name.
- `OPERATOR_CONTACT`: how to reach them, as the public pages say it. It becomes the var of that name.

The Worker's own secrets, such as the bot's token, are not among the six: they are set on the Worker, and a deploy
leaves them as they are.

The `wrangler` that the workflow runs is a dev dependency of the project's own, pinned to one version. It is the
version that `@cloudflare/vitest-plugin` depends on, so the tests and a deploy use the same one, and the pin is to
be raised when the plugin is.

When this was written, the workflow had not run on GitHub, and a token with only those two permissions had not
been tried. What was tried is the script, with made-up values, and the last step, against a server on the same
machine.
