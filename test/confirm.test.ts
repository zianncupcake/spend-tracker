import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { refreshAccessToken } from '../src/google/gmail'
import { saying } from './ai-helpers'
import {
  approve,
  attemptOf,
  clock,
  codeOn,
  connectedChat,
  connectionOf,
  deps,
  linkIn,
  MINUTE,
  NOW,
  open,
  openChat,
  otherThan,
  outside,
  sent,
  signIn,
  tokenIn,
} from './connect-helpers'
import { linesOf } from './helpers'
import { catchConsole } from './log-helpers'

const NOTHING_WAITING =
  'No sign-in is waiting for a code. It may have expired, or had too many wrong codes. Send /connect to start again.'

describe('the confirmation code', () => {
  it.each([
    ['on its own', (code: string) => code],
    ['with space around it', (code: string) => `  ${code}\n`],
    ['after /code', (code: string) => `/code ${code}`],
  ])('connects the mailbox when it is sent %s', async (_, message) => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    const userId = await chat.userId()

    const reply = await chat.say(message(code))

    expect(reply).toBe('Connected jane@example.test. Your bank alerts will start being read within a few minutes.')
    const connection = await connectionOf(userId)
    expect(connection).toMatchObject({ email: 'jane@example.test', status: 'active', last_checked_at: null })
    expect(connection?.refresh_token_enc).not.toContain(outside.issued[0])
    expect(await tokenIn(connection)).toBe(outside.issued[0])
    expect(await attemptOf(userId)).toBeNull()
    expect(outside.revoked).toEqual([])
  })

  it('counts down the tries on a wrong code, and still takes the right code as the fifth', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    const wrong = otherThan(code)

    const replies = [await chat.say(wrong), await chat.say(wrong), await chat.say(wrong), await chat.say(wrong)]

    expect(replies).toEqual([
      'That code is not right. You have 4 tries left.',
      'That code is not right. You have 3 tries left.',
      'That code is not right. You have 2 tries left.',
      'That code is not right. You have 1 try left.',
    ])
    expect(await connectionOf(await chat.userId())).toBeNull()
    expect(outside.revoked).toEqual([])
    expect(await chat.say(code)).toContain('Connected jane@example.test')
  })

  it('gives the mailbox up on the fifth wrong code: deletes the attempt and revokes its token', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    const userId = await chat.userId()
    const wrong = otherThan(code)
    for (let tries = 1; tries <= 4; tries++) await chat.say(wrong)

    const reply = await chat.say(wrong)

    expect(reply).toBe(NOTHING_WAITING)
    expect(await attemptOf(userId)).toBeNull()
    expect(outside.revoked).toEqual([outside.issued[0]])
    // The right code is no use any more.
    expect(await chat.say(code)).toBe(NOTHING_WAITING)
    expect(await connectionOf(userId)).toBeNull()
  })

  it('does not let codes sent together have more than five tries between them', async () => {
    const chat = openChat()
    const wrong = otherThan(await signIn(chat, 'jane@example.test'))

    await Promise.all(Array.from({ length: 12 }, () => chat.send(wrong)))

    const replies = sent.map((message) => message.text)
    expect(replies.filter((reply) => reply.startsWith('That code is not right'))).toHaveLength(4)
    expect(replies.filter((reply) => reply === NOTHING_WAITING)).toHaveLength(8)
    expect(await attemptOf(await chat.userId())).toBeNull()
    expect(outside.revoked).toEqual([outside.issued[0]])
  })

  it('takes no sixth try, not even the right code', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    const userId = await chat.userId()
    // An attempt is only ever like this between its fifth wrong code being counted and its being deleted.
    await env.DB.prepare('UPDATE connect_attempts SET confirm_tries = 5 WHERE owner_id = ?').bind(userId).run()

    expect(await chat.say(code)).toBe(NOTHING_WAITING)

    expect(await connectionOf(userId)).toBeNull()
  })

  it('takes the code up to ten minutes after it was shown', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    clock.now = new Date(NOW.getTime() + 10 * MINUTE - 1000)

    expect(await chat.say(code)).toContain('Connected jane@example.test')
  })

  it('gives the mailbox up when the code comes too late: deletes the attempt and revokes its token', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    const userId = await chat.userId()
    clock.now = new Date(NOW.getTime() + 10 * MINUTE)

    const reply = await chat.say(code)

    expect(reply).toBe(NOTHING_WAITING)
    expect(await attemptOf(userId)).toBeNull()
    expect(await connectionOf(userId)).toBeNull()
    expect(outside.revoked).toEqual([outside.issued[0]])
  })

  it('has nothing to confirm before Google has redirected back, and leaves the open link alone', async () => {
    const chat = openChat()
    expect(await chat.say('123456')).toBe(NOTHING_WAITING)

    const link = linkIn(await chat.say('/connect'))
    expect(await chat.say('123456')).toBe(NOTHING_WAITING)

    // Six digits are a code whether or not one is waited for, and never a question for the assistant.
    expect(outside.completions).toEqual([])
    expect(outside.revoked).toEqual([])
    expect((await open(link)).status).toBe(302)
    expect(await chat.say(await codeOn(await approve(link, 'jane@example.test')))).toContain('Connected')
  })

  it.each(['/code', '/code 12345', '/code 1234567', '/code 12345a', '/code 123456 123456'])(
    'answers "%s" with the usage',
    async (message) => {
      expect(await openChat().say(message)).toBe('Usage: /code <6-digit code>')
    },
  )

  it.each(['12345', '1234567', '12345a', '123 456', '123456 please'])(
    'does not take "%s" for a code: it is a question for the assistant',
    async (message) => {
      const chat = openChat()
      const code = await signIn(chat, 'jane@example.test')
      outside.model = [saying('I can only answer questions about your card spending.')]

      const answer = await chat.rich(message)

      // The model was asked what the message says, and its answer is the reply.
      expect(outside.completions).toHaveLength(1)
      expect(outside.completions[0].body.messages[1]).toEqual({ role: 'user', content: message })
      expect(linesOf(answer)).toEqual(['I can only answer questions about your card spending.'])
      // It was not counted as a try either.
      expect(await attemptOf(await chat.userId())).toMatchObject({ confirm_tries: 0 })
      expect(await chat.say(code)).toContain('Connected')
    },
  )

  it.each([
    ['the right code', (code: string) => code, 'Connected jane@example.test'],
    ['a wrong one', otherThan, 'That code is not right.'],
  ])('takes six digits for a code, and asks the assistant nothing, when they are %s', async (_, digits, reply) => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')

    expect(await chat.say(digits(code))).toContain(reply)

    expect(outside.completions).toEqual([])
  })
})

describe('what the log has of a code', () => {
  /** The line of the message that brought a code, which comes after the line of what came of the code. */
  const CAME = { event: 'update', kind: 'code', outcome: 'replied', ms: 0 }

  it('is that it connected a mailbox, and for which user: nothing of the code or of the mailbox', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    const logged = catchConsole()

    await chat.say(code)

    expect(logged.events()).toEqual([
      { event: 'connect_code', user: await chat.userId(), outcome: 'connected' },
      CAME,
    ])
    for (const text of [code, 'jane', 'example.test', String(chat.telegramId)]) {
      expect(logged.text()).not.toContain(text)
    }
  })

  it('is each wrong code with the tries that are left, and then that the mailbox was let go', async () => {
    const chat = openChat()
    const wrong = otherThan(await signIn(chat, 'jane@example.test'))
    const userId = await chat.userId()
    const logged = catchConsole()

    for (let tries = 1; tries <= 6; tries++) await chat.say(wrong)

    const code = (fields: object) => ({ event: 'connect_code', user: userId, ...fields })
    // Besides the line of each of the six messages that brought a code.
    expect(logged.events().filter((each) => each.event !== 'update')).toEqual([
      code({ outcome: 'wrong', tries_left: 4 }),
      code({ outcome: 'wrong', tries_left: 3 }),
      code({ outcome: 'wrong', tries_left: 2 }),
      code({ outcome: 'wrong', tries_left: 1 }),
      // The fifth gives the mailbox up, at Google too. For the sixth, no sign-in is waiting.
      { event: 'token_revoke', outcome: 'revoked' },
      code({ outcome: 'out_of_tries' }),
      code({ outcome: 'no_attempt' }),
    ])
    expect(logged.events('update')).toEqual([CAME, CAME, CAME, CAME, CAME, CAME])
    expect(logged.text()).not.toContain(wrong)
  })

  it('is that the sign-in had expired, when the code came too late, with its mailbox let go', async () => {
    const chat = openChat()
    const code = await signIn(chat, 'jane@example.test')
    clock.now = new Date(NOW.getTime() + 10 * MINUTE)
    const logged = catchConsole()

    await chat.say(code)

    expect(logged.events()).toEqual([
      { event: 'token_revoke', outcome: 'revoked' },
      { event: 'connect_code', user: await chat.userId(), outcome: 'expired' },
      CAME,
    ])
  })

  it('is that no sign-in was waiting, for six digits that are sent when none is', async () => {
    const chat = openChat()
    const userId = await chat.userId()
    const logged = catchConsole()

    await chat.say('123456')

    expect(logged.events()).toEqual([{ event: 'connect_code', user: userId, outcome: 'no_attempt' }, CAME])
  })
})

describe('a link opened by somebody else', () => {
  it("connects nothing when the code is sent from another user's chat", async () => {
    const attacker = openChat()
    const victim = openChat()
    await victim.say('/start')

    // The attacker sends the victim their own link. The victim opens it and approves with their own mailbox.
    const link = linkIn(await attacker.say('/connect'))
    const code = await codeOn(await approve(link, 'victim@example.test'))

    // The victim's browser shows the code. The attacker's chat is only told that somebody signed in.
    expect(sent).toHaveLength(1)
    expect(sent[0].chatId).toBe(attacker.telegramId)
    expect(sent[0].text).not.toContain(code)
    sent.length = 0

    // The victim does what the page says, in their own chat with the bot.
    expect(await victim.say(code)).toBe(NOTHING_WAITING)

    expect(await connectionOf(await victim.userId())).toBeNull()
    expect(await connectionOf(await attacker.userId())).toBeNull()
    // It did not touch the attacker's attempt either, which still waits for a code the attacker does not have.
    expect(await attemptOf(await attacker.userId())).toMatchObject({ email: 'victim@example.test', confirm_tries: 0 })

    // All the attacker can do is guess, and five wrong guesses give the victim's mailbox up.
    const guess = otherThan(code)
    for (let guesses = 1; guesses <= 5; guesses++) await attacker.say(guess)
    expect(await attemptOf(await attacker.userId())).toBeNull()
    expect(await connectionOf(await attacker.userId())).toBeNull()
    expect(outside.revoked).toEqual([outside.issued[0]])
  })

  // The ways in which a sign-in that holds a mailbox comes to nothing in the chat it was started from.
  it.each<[how: string, end: (other: ReturnType<typeof openChat>, code: string) => Promise<unknown>]>([
    [
      'runs out of tries',
      async (other, code) => {
        for (let tries = 1; tries <= 5; tries++) await other.say(otherThan(code))
      },
    ],
    [
      'sends the code too late',
      (other, code) => {
        clock.now = new Date(NOW.getTime() + 10 * MINUTE)
        return other.say(code)
      },
    ],
    ['asks for a new link', (other) => other.say('/connect')],
    ['disconnects', (other) => other.say('/disconnect')],
    ['deletes everything', (other) => other.say('/delete confirm')],
  ])("leaves the connection of the mailbox's owner working when the other user %s", async (_, end) => {
    const owner = await connectedChat('jane@example.test')
    // The owner is got to open another user's link, and approves it with the mailbox that they have connected.
    const other = openChat()
    const otherId = await other.userId()
    const code = await signIn(other, 'jane@example.test')
    expect(await attemptOf(otherId)).toMatchObject({ email: 'jane@example.test' })

    await end(other, code)

    // The sign-in is over and the token it held is deleted, but not revoked. Google ends every token of an
    // account when it revokes one of them, so the owner's connection would have gone with it.
    expect((await attemptOf(otherId))?.email ?? null).toBeNull()
    expect(outside.revoked).toEqual([])
    const ownersToken = await tokenIn(await connectionOf(await owner.userId()))
    expect(await refreshAccessToken(deps.google, ownersToken)).toBe('access-token-of-jane@example.test')

    // Google is told when the last of the mailbox is let go.
    await owner.say('/disconnect')
    expect(outside.revoked).toEqual([ownersToken])
  })

  it('finishes only the sign-in of the chat a code is sent in, when two users are both signing in', async () => {
    const first = openChat()
    const second = openChat()
    const [firstId, secondId] = [await first.userId(), await second.userId()]
    const firstCode = await signIn(first, 'jane@example.test')
    const secondCode = await signIn(second, 'sam@example.test')

    expect(await first.say(firstCode)).toContain('Connected jane@example.test')

    expect(await connectionOf(secondId)).toBeNull()
    expect(await attemptOf(secondId)).toMatchObject({ email: 'sam@example.test', confirm_tries: 0 })
    expect(await second.say(secondCode)).toContain('Connected sam@example.test')
    expect(await tokenIn(await connectionOf(firstId))).toBe(outside.issued[0])
    expect(await tokenIn(await connectionOf(secondId))).toBe(outside.issued[1])
  })
})
