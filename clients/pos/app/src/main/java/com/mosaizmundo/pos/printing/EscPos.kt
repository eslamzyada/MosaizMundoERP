package com.mosaizmundo.pos.printing

/**
 * The ESC/POS byte stream a thermal printer understands.
 *
 * DELIBERATELY FREE OF ANDROID. Everything here is arithmetic on bytes, which
 * means it can be tested on the JVM against exact expected output — and the
 * byte stream is the one part of printing that is worth testing, because it is
 * the part where an off-by-one produces a metre of garbage instead of a ticket.
 * The Android-specific work (turning Arabic text into pixels) lives in
 * TicketRenderer, and hands back a [MonoBitmap] that this file can encode.
 *
 * WHY IMAGES AND NOT TEXT. ESC/POS has text commands, and for Latin text they
 * are the obvious choice. For Arabic they are close to useless: most cheap
 * thermal printers ship no Arabic codepage at all, and the ones that do (CP864)
 * store isolated letterforms with no contextual shaping — "مطبخ" comes out as
 * four disconnected glyphs in the wrong order, if anything comes out. Rendering
 * the text to a bitmap and sending it as a raster puts Android's text engine in
 * charge of shaping and direction, which is where that competence already
 * lives. It costs bandwidth we have (a few KB over LAN) to buy correctness we
 * cannot otherwise get.
 */
object EscPos {
    private const val ESC: Byte = 0x1B
    private const val GS: Byte = 0x1D
    const val LF: Byte = 0x0A

    /**
     * ESC @ — reset. Sent first on every job because a printer holds state
     * (alignment, emphasis, line spacing) across connections, so a ticket that
     * did not reset would inherit whatever the previous one left behind.
     */
    fun initialise(): ByteArray = byteArrayOf(ESC, 0x40)

    /** ESC d n — feed n lines, to clear the tear bar before the cut. */
    fun feed(lines: Int): ByteArray {
        require(lines in 0..255) { "feed lines must fit in a byte, got $lines" }
        return byteArrayOf(ESC, 0x64, lines.toByte())
    }

    /**
     * GS V 66 n — partial cut, leaving a small tab so the ticket does not fall
     * on the floor. n is fed before cutting: cutters sit some millimetres past
     * the print head, so without it the last lines are cut through.
     */
    fun cut(feedBefore: Int = 3): ByteArray {
        require(feedBefore in 0..255) { "cut feed must fit in a byte, got $feedBefore" }
        return byteArrayOf(GS, 0x56, 0x42, feedBefore.toByte())
    }

    /**
     * GS v 0 — print a raster bitmap.
     *
     * Layout: `GS v 0 m xL xH yL yH [data]`, where x is the row WIDTH IN BYTES
     * (not pixels) and y is the height in pixels. Each row is packed
     * MSB-first — bit 7 of the first byte is the leftmost pixel — and a SET bit
     * means black, because a thermal printer burns where it is told to.
     *
     * A width that is not a multiple of 8 is padded with clear bits on the
     * right. That padding is not cosmetic: the printer reads exactly
     * xBytes * height bytes and takes whatever follows as its next command, so
     * a short row turns the rest of the ticket into random instructions.
     */
    fun raster(bitmap: MonoBitmap): ByteArray {
        val widthBytes = (bitmap.width + 7) / 8
        val header = byteArrayOf(
            GS, 0x76, 0x30, 0x00,
            (widthBytes and 0xFF).toByte(), ((widthBytes shr 8) and 0xFF).toByte(),
            (bitmap.height and 0xFF).toByte(), ((bitmap.height shr 8) and 0xFF).toByte(),
        )

        val data = ByteArray(widthBytes * bitmap.height)
        for (y in 0 until bitmap.height) {
            val rowStart = y * widthBytes
            for (x in 0 until bitmap.width) {
                if (bitmap.isBlack(x, y)) {
                    val index = rowStart + (x / 8)
                    // Bit 7 is the leftmost pixel of the byte.
                    data[index] = (data[index].toInt() or (0x80 shr (x % 8))).toByte()
                }
            }
        }
        return header + data
    }

    /**
     * A complete job: reset, the image, a feed, and a cut.
     *
     * Kept as one function so no caller can forget the reset at the front or
     * the cut at the back — a ticket that never cuts stays attached to the next
     * one, and a kitchen ends up tearing two orders apart by hand.
     */
    fun ticket(bitmap: MonoBitmap): ByteArray =
        initialise() + raster(bitmap) + feed(2) + cut()
}

/**
 * A one-bit-per-pixel image: exactly what a thermal printer can render.
 *
 * Held as a BooleanArray rather than an Android Bitmap so the encoder above,
 * and its tests, need no Android runtime. TicketRenderer is what converts a
 * real Bitmap into one of these.
 */
class MonoBitmap(
    val width: Int,
    val height: Int,
    private val pixels: BooleanArray,
) {
    init {
        require(width > 0 && height > 0) { "a bitmap needs positive dimensions" }
        require(pixels.size == width * height) {
            "expected ${width * height} pixels, got ${pixels.size}"
        }
    }

    /** True where the printer should burn. */
    fun isBlack(x: Int, y: Int): Boolean = pixels[y * width + x]

    companion object {
        /** Builds one from a row-major predicate — used by tests and by rendering. */
        fun of(width: Int, height: Int, black: (x: Int, y: Int) -> Boolean): MonoBitmap {
            val pixels = BooleanArray(width * height)
            for (y in 0 until height) {
                for (x in 0 until width) {
                    pixels[y * width + x] = black(x, y)
                }
            }
            return MonoBitmap(width, height, pixels)
        }
    }
}
