package com.mosaizmundo.pos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.mosaizmundo.pos.data.local.PosDatabase
import com.mosaizmundo.pos.data.local.TokenManager
import com.mosaizmundo.pos.domain.HttpPosRepository
import com.mosaizmundo.pos.ui.screens.LoginScreen
import com.mosaizmundo.pos.ui.screens.MenuScreen
import com.mosaizmundo.pos.ui.theme.MosaizPosTheme
import com.mosaizmundo.pos.ui.viewmodel.AuthViewModel
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
                        val appContext = LocalContext.current.applicationContext
                        val tokenManager = remember { TokenManager(appContext) }

                        var loading by remember { mutableStateOf(true) }
                        var token by remember { mutableStateOf<String?>(null) }
                        LaunchedEffect(Unit) {
                            tokenManager.getToken().collect { value ->
                                token = value
                                loading = false
                            }
                        }

                        when {
                            loading -> LoadingSplash()
                            token == null -> {
                                val authViewModel: AuthViewModel = viewModel(
                                    factory = viewModelFactory {
                                        initializer { AuthViewModel(tokenManager, appContext) }
                                    },
                                )
                                LoginScreen(authViewModel)
                            }
                            else -> {
                                val repository = remember {
                                    val dao = PosDatabase.getInstance(appContext).offlineOrderDao()
                                    HttpPosRepository(dao, appContext)
                                }
                                val posViewModel: PosViewModel = viewModel(
                                    factory = viewModelFactory {
                                        initializer { PosViewModel(repository) }
                                    },
                                )
                                MenuScreen(posViewModel)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LoadingSplash() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = "Mosaiz Mundo",
            color = MaterialTheme.colorScheme.onBackground,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}
