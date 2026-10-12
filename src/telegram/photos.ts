// The reading of a photo: which of its sizes is fetched, and the reply that the reading comes to, which is made
// once Telegram has been told that the update was taken.

import { asPhotoCard, MAX_PURCHASES_PER_PHOTO, readPhoto } from '../ai/photo'
import type { AiProvider } from '../ai/provider'
import type { Deps } from '../deps'
import { Failure, log, logFailure, type Events } from '../log'
import { findOrCreateUser, storeFor } from '../store'
import { addRead, readBefore, type Adding } from './adding'
import type { Messenger } from './api'
import { busyReply } from './replies'
import type { Deferred, Made } from './sending'
import {
  NO_CARDS,
  NO_PURCHASES,
  PHOTO_NOT_READ,
  PHOTO_READ_NO_REPLY,
  PHOTO_TOO_LARGE,
  PHOTO_TOOK_TOO_LONG,
  READ_ALREADY,
  READING,
} from './texts'

/**
 * What the log has of a photo, but for how long its reading took, and for what was done with the purchases that
 * were read from it, which is noted where it is done: see Adding. See `photo` in ../log.
 */
type Read = Omit<Events['photo'], 'stored' | 'held' | 'ms'>

/** One of the sizes that Telegram keeps a photo in, as far as the bot goes by it. */
interface PhotoSize {
  /** What its file is asked for by. */
  fileId: string
  /** How many pixels it has: its width by its height. */
  pixels: number
  /** How many bytes its file has, when Telegram says. */
  bytes?: number
}

/**
 * The most bytes of a photo that the bot fetches to have it read: about 400 KB. Telegram keeps a photo in several
 * sizes, and the one that is read is the largest that is no more than this. A photo goes to the model as text, in
 * base64, and the encoding of it costs CPU time, of which an invocation has about 10 ms on the free plan.
 */
const MAX_PHOTO_BYTES = 400_000

/** What a photo is, as the model is told it. Telegram keeps a photo as a JPEG, whatever it was sent as. */
const PHOTO_MIME = 'image/jpeg'

/**
 * The sizes of a photo that a file can be asked for, from what Telegram posted of the photo, which nothing has
 * checked. None for a message that has no photo.
 */
export function sizesOf(photo: unknown): PhotoSize[] {
  if (!Array.isArray(photo)) return []
  return photo.flatMap((size: { file_id?: unknown; width?: unknown; height?: unknown; file_size?: unknown } | null) => {
    if (typeof size?.file_id !== 'string') return []
    const { file_id: fileId, width, height, file_size: bytes } = size
    const pixels = typeof width === 'number' && typeof height === 'number' ? width * height : 0
    return [{ fileId, pixels, bytes: typeof bytes === 'number' ? bytes : undefined }]
  })
}

/**
 * The size of a photo to fetch: the largest of those that have no more than MAX_PHOTO_BYTES. A size that Telegram
 * gave no number of bytes for is taken to be one of them: `Messenger.file` fetches no more than so many bytes, and
 * says so when a file has more. Nothing when every size is known to have more.
 */
function sizeToFetch(sizes: PhotoSize[]): PhotoSize | undefined {
  const fitting = sizes.filter(({ bytes }) => bytes === undefined || bytes <= MAX_PHOTO_BYTES)
  // Of two that have as many pixels, the later is taken.
  return fitting.reduce<PhotoSize | undefined>(
    (largest, size) => (largest && largest.pixels > size.pixels ? largest : size),
    undefined,
  )
}

/**
 * The bytes of a file of Telegram's that is to be read as a photo, which may have no more than MAX_PHOTO_BYTES.
 * Nothing for a file that has more.
 */
async function bytesOf(messenger: Messenger, fileId: string): Promise<Uint8Array | undefined> {
  try {
    return await messenger.file(fileId, MAX_PHOTO_BYTES)
  } catch (error) {
    if (error instanceof Failure && error.reason === 'file_too_large') return undefined
    throw error
  }
}

/**
 * The reading of a photo, which is a reply that is still to be made, as the answer to a question is: see sendLater
 * for what its user is shown in the meantime. The largest of the photo's sizes that is small enough is fetched from
 * Telegram and read by a model, with the caption and with what the user's cards are called and sorted into. What
 * is then done with the purchases that the model read is addRead's to do.
 */
export function readLater(
  deps: Deps,
  ai: AiProvider,
  telegramId: number,
  messageId: number,
  sizes: PhotoSize[],
  caption: string,
): Deferred<Read['outcome']> {
  const { db, messenger } = deps
  // Until more is learnt of it, the photo is one whose reading failed, of a user who is not known, with nothing said.
  const noted: Read = {
    user: null,
    outcome: 'failed',
    sent: 'none',
    placeholder: false,
    bytes: 0,
    requests: 0,
    read: 0,
    unreadable: 0,
  }
  const adding: Adding = { stored: 0, held: 0, kept: false, late: false }
  // Whether anything of the photo is stored, or is held for its user to answer for. From then on its user is not
  // told to send it again: see PHOTO_READ_NO_REPLY.
  const taken = () => adding.kept || adding.held > 0
  // What the reading comes to when its time is up.
  const outOfTime = (): Made<Read['outcome']> => ({
    outcome: 'timeout',
    notice: taken() ? PHOTO_READ_NO_REPLY : PHOTO_TOOK_TOO_LONG,
    error: new Failure('took_too_long', 'The photo took too long to read'),
  })

  return {
    placeholder: READING,
    noted,
    async make() {
      // A photo needs a user as a command does: its purchases go into their store, on a card of theirs.
      const user = await findOrCreateUser(db, telegramId)
      noted.user = user.id
      const cards = await storeFor(db, user.id).listCards()
      if (cards.length === 0) return { outcome: 'no_cards', notice: NO_CARDS }
      // A photo that was read before is not fetched, and the model is not asked about it again: see readBefore.
      if (await readBefore(deps, user.id, messageId)) return { outcome: 'repeated', notice: READ_ALREADY }

      const size = sizeToFetch(sizes)
      const image = size && (await bytesOf(messenger, size.fileId))
      if (!image) return { outcome: 'too_large', notice: PHOTO_TOO_LARGE }
      noted.bytes = image.byteLength

      const input = { image, mime: PHOTO_MIME, caption, cards: cards.map(asPhotoCard), timeZone: user.timezone }
      const reading = await readPhoto(deps, ai, input, noted)
      switch (reading.status) {
        case 'nothing':
          return { outcome: 'nothing', notice: NO_PURCHASES }
        case 'busy':
          return { outcome: 'busy', notice: busyReply(reading.retryAfter), error: reading.error }
        case 'timeout':
          return { outcome: 'timeout', notice: PHOTO_TOOK_TOO_LONG, error: reading.error }
        case 'failed':
          return { outcome: 'failed', notice: PHOTO_NOT_READ, error: reading.error }
      }
      noted.read = Math.min(reading.purchases.length, MAX_PURCHASES_PER_PHOTO)
      noted.unreadable = reading.unreadable
      const added = await addRead(deps, user, cards, reading, messageId, adding)
      if (!added) return outOfTime()
      // A reading that left nothing to tell of is one that found nothing to add.
      if (!added.rich && added.text.length === 0) return { outcome: 'nothing', notice: NO_PURCHASES }
      return { outcome: 'read', ...added }
    },
    late() {
      adding.late = true
      return outOfTime()
    },
    failed: () => (taken() ? PHOTO_READ_NO_REPLY : PHOTO_NOT_READ),
    record(ms, wrong) {
      const line = { ...noted, stored: adding.stored, held: adding.held, ms }
      // Nothing of an error's message is logged: it could quote what the photo held, or what is stored.
      if (wrong === undefined) log('photo', line)
      else logFailure('photo', wrong, line)
    },
  }
}
