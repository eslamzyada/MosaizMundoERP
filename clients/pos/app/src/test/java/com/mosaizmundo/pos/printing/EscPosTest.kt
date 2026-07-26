package com.mosaizmundo.pos.printing

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ESC/POS byte stream, asserted byte for byte.
 *
 * This is worth testing exactly because it is unreadable: a printer given a
 * header that disagrees with the data length does not fail, it prints the rest
 * of the ticket as though the bytes were commands and spits out a metre of
 * garbage. Nothing downstream catches that, and on real hardware you find out
 * by watching the paper.
 */
class EscPosTest {

    @Test
    fun `initialise is ESC @`() {
        assertArrayEquals(byteArrayOf(0x1B, 0x40), EscPos.initialise())
    }

    @Test
    fun `cut feeds before cutting`() {
        // The cutter sits past the print head; without the feed the last lines
        // of the ticket are cut through.
        assertArrayEquals(byteArrayOf(0x1D, 0x56, 0x42, 3), EscPos.cut())
        assertArrayEquals(byteArrayOf(0x1D, 0x56, 0x42, 0), EscPos.cut(feedBefore = 0))
    }

    @Test
    fun `raster header states the row width in BYTES, not pixels`() {
        // 16 pixels wide is 2 bytes per row. Sending 16 here would make the
        // printer read 16 bytes per row and consume the whole ticket as one row.
        val bitmap = MonoBitmap.of(16, 3) { _, _ -> false }
        val bytes = EscPos.raster(bitmap)

        assertArrayEquals(
            byteArrayOf(0x1D, 0x76, 0x30, 0x00, 2, 0, 3, 0),
            bytes.copyOfRange(0, 8),
        )
        assertEquals(8 + 2 * 3, bytes.size)
    }

    @Test
    fun `a set bit is black, packed MSB-first from the left`() {
        // One row, leftmost pixel only: 1000 0000.
        val leftmost = MonoBitmap.of(8, 1) { x, _ -> x == 0 }
        assertEquals(0x80.toByte(), EscPos.raster(leftmost).last())

        // Rightmost of the byte: 0000 0001.
        val rightmost = MonoBitmap.of(8, 1) { x, _ -> x == 7 }
        assertEquals(0x01.toByte(), EscPos.raster(rightmost).last())

        // Left half: 1111 0000. Reversed bit order would give 0x0F.
        val leftHalf = MonoBitmap.of(8, 1) { x, _ -> x < 4 }
        assertEquals(0xF0.toByte(), EscPos.raster(leftHalf).last())
    }

    @Test
    fun `a width that is not a multiple of eight is padded, not truncated`() {
        // 12 pixels -> 2 bytes per row, the last 4 bits unused. If the encoder
        // emitted only the bits it had, the printer would read the following
        // command bytes as image data and print the rest of the job as noise.
        val bitmap = MonoBitmap.of(12, 2) { _, _ -> true }
        val bytes = EscPos.raster(bitmap)

        assertEquals(8 + 2 * 2, bytes.size)
        val firstRow = bytes.copyOfRange(8, 10)
        assertEquals(0xFF.toByte(), firstRow[0])
        // Four pixels set, four pad bits clear: 1111 0000.
        assertEquals(0xF0.toByte(), firstRow[1])
    }

    @Test
    fun `rows are independent`() {
        // Row 0 all black, row 1 all white. A shared offset bug shows up here
        // as both rows being the same.
        val bitmap = MonoBitmap.of(8, 2) { _, y -> y == 0 }
        val data = EscPos.raster(bitmap).copyOfRange(8, 10)
        assertEquals(0xFF.toByte(), data[0])
        assertEquals(0x00.toByte(), data[1])
    }

    @Test
    fun `a full job resets first and cuts last`() {
        val job = EscPos.ticket(MonoBitmap.of(8, 1) { _, _ -> true })

        // A printer keeps alignment and emphasis across connections, so a job
        // that does not reset inherits whatever the last one left behind.
        assertArrayEquals(byteArrayOf(0x1B, 0x40), job.copyOfRange(0, 2))
        // And a job that never cuts leaves this ticket attached to the next.
        assertArrayEquals(byteArrayOf(0x1D, 0x56, 0x42, 3), job.copyOfRange(job.size - 4, job.size))
    }

    @Test
    fun `large dimensions use both length bytes`() {
        // 576 dots is an 80mm printer: 72 bytes per row, which still fits one
        // byte — but 300 rows does not, and a height truncated to its low byte
        // would print the top 44 rows and treat the rest as commands.
        val bitmap = MonoBitmap.of(TicketRendererWidths.EIGHTY_MM, 300) { _, _ -> false }
        val header = EscPos.raster(bitmap).copyOfRange(0, 8)

        assertEquals(72.toByte(), header[4])
        assertEquals(0.toByte(), header[5])
        assertEquals((300 and 0xFF).toByte(), header[6])
        assertEquals((300 shr 8).toByte(), header[7])
    }

    @Test
    fun `a bitmap must be self-consistent`() {
        val tooFew = runCatching { MonoBitmap(4, 4, BooleanArray(10)) }
        assertTrue("a mismatched pixel count must be refused", tooFew.isFailure)
    }
}

/**
 * The dot widths of the two common paper sizes, duplicated here rather than
 * imported from TicketRenderer — that file touches android.graphics and cannot
 * be loaded in a JVM test.
 */
private object TicketRendererWidths {
    const val EIGHTY_MM = 576
}
