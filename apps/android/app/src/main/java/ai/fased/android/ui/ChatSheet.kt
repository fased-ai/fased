package ai.fased.android.ui

import androidx.compose.runtime.Composable
import ai.fased.android.MainViewModel
import ai.fased.android.ui.chat.ChatSheetContent

@Composable
fun ChatSheet(viewModel: MainViewModel) {
  ChatSheetContent(viewModel = viewModel)
}
