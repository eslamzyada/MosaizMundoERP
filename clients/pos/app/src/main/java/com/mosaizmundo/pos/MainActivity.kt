package com.mosaizmundo.pos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.mosaizmundo.pos.domain.HttpPosRepository
import com.mosaizmundo.pos.ui.screens.MenuScreen
import com.mosaizmundo.pos.ui.theme.MosaizPosTheme
import com.mosaizmundo.pos.ui.viewmodel.PosViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            // Arabic-first: force RTL regardless of the device locale.
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                MosaizPosTheme {
                    Surface(
                        color = MaterialTheme.colorScheme.background,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        val repository = remember { HttpPosRepository() }
                        val viewModel: PosViewModel = viewModel(
                            factory = viewModelFactory {
                                initializer { PosViewModel(repository) }
                            },
                        )
                        MenuScreen(viewModel)
                    }
                }
            }
        }
    }
}
