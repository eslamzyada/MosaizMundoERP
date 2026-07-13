package com.mosaizmundo.pos.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val MosaizDarkColors = darkColorScheme(
    primary = SunsetPrimary,
    onPrimary = Color.White,
    background = TwilightDark,
    onBackground = TextPrimary,
    surface = TwilightCard,
    onSurface = TextPrimary,
    onSurfaceVariant = TextMuted,
)

/**
 * A POS tablet always runs dark, so this theme ignores the system setting and
 * always applies the Mosaiz Mundo dark color scheme.
 */
@Composable
fun MosaizPosTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = MosaizDarkColors,
        content = content,
    )
}
