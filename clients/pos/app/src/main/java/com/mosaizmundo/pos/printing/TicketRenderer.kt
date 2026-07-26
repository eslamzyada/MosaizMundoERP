package com.mosaizmundo.pos.printing

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface

/**
 * Draws a [Ticket] into pixels.
 *
 * THIS is the file that needs Android, and it is kept as thin as possible for
 * that reason: everything either side of it — what the ticket says, and how the
 * pixels become ESC/POS — is plain Kotlin that tests can reach.
 *
 * Android's text engine is here to do one job that nothing else available can:
 * shape Arabic. Arabic letters change form by position and join into ligatures,
 * and the order they are laid out in is right-to-left. A printer's own Arabic
 * support, where it exists at all, is a codepage of isolated letterforms with
 * none of that. Handing the string to Canvas.drawText with RTL alignment gets
 * the same shaping the rest of the app already relies on, and the printer only
 * ever sees dots.
 */
object TicketRenderer {

    /**
     * 384 dots is the printable width of a standard 58mm thermal printer, and
     * 576 of an 80mm one. Everything below is expressed in dots for that
     * reason — a "font size" here is a physical height on paper.
     */
    const val WIDTH_58MM = 384
    const val WIDTH_80MM = 576

    private const val PADDING = 8f
    private const val BODY_SIZE = 24f
    private const val HEADING_SIZE = 34f
    private const val LINE_GAP = 10f

    private fun paintFor(emphasis: TicketLine.Emphasis, width: Int): Paint = Paint().apply {
        isAntiAlias = true
        color = Color.BLACK
        textAlign = Paint.Align.RIGHT
        when (emphasis) {
            TicketLine.Emphasis.HEADING -> {
                textSize = HEADING_SIZE
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            }
            TicketLine.Emphasis.INSTRUCTION -> {
                textSize = BODY_SIZE
                // Bold, not italic: italic Arabic is a synthetic slant that
                // damages the letterforms, and an instruction has to stay
                // legible at arm's length on damp paper.
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            }
            TicketLine.Emphasis.NORMAL -> {
                textSize = BODY_SIZE
                typeface = Typeface.DEFAULT
            }
        }
    }

    /** Height in dots this ticket will occupy, computed before allocating. */
    private fun heightOf(ticket: Ticket, width: Int): Int {
        var height = PADDING * 2
        for (line in ticket.lines) {
            val paint = paintFor(line.emphasis, width)
            val metrics = paint.fontMetrics
            height += (metrics.descent - metrics.ascent) + LINE_GAP
        }
        return height.toInt().coerceAtLeast(1)
    }

    /**
     * Renders to a monochrome bitmap ready for [EscPos.raster].
     *
     * Right-aligned throughout, which is what an RTL receipt looks like — the
     * eye starts at the right edge, so left-aligned Arabic reads as ragged and
     * wrong even when every glyph is correct.
     */
    fun render(ticket: Ticket, width: Int = WIDTH_58MM): MonoBitmap {
        val height = heightOf(ticket, width)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)

        var y = PADDING
        for (line in ticket.lines) {
            val paint = paintFor(line.emphasis, width)
            val metrics = paint.fontMetrics
            y -= metrics.ascent
            if (line.text.isNotEmpty()) {
                canvas.drawText(line.text, width - PADDING, y, paint)
            }
            y += metrics.descent + LINE_GAP
        }

        return toMono(bitmap)
    }

    /**
     * Threshold to one bit per pixel.
     *
     * A plain luminance cut rather than dithering: a ticket is text, and
     * dithering text on a 203-dpi head makes it grey and fuzzy. The threshold
     * sits high (any pixel not close to white burns) so antialiased edges stay
     * part of the glyph — Arabic has thin joins that vanish at a middling
     * threshold, which turns a word into disconnected marks.
     */
    private fun toMono(bitmap: Bitmap): MonoBitmap {
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        val black = BooleanArray(width * height)
        for (i in pixels.indices) {
            val p = pixels[i]
            val luminance =
                0.299 * ((p shr 16) and 0xFF) + 0.587 * ((p shr 8) and 0xFF) + 0.114 * (p and 0xFF)
            black[i] = luminance < 200
        }
        bitmap.recycle()
        return MonoBitmap(width, height, black)
    }
}
