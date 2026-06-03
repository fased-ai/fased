package ai.fased.android.node

import ai.fased.android.protocol.FasedAgentCanvasA2UICommand
import ai.fased.android.protocol.FasedAgentCanvasCommand
import ai.fased.android.protocol.FasedAgentCameraCommand
import ai.fased.android.protocol.FasedAgentDeviceCommand
import ai.fased.android.protocol.FasedAgentLocationCommand
import ai.fased.android.protocol.FasedAgentNotificationsCommand
import ai.fased.android.protocol.FasedAgentScreenCommand
import ai.fased.android.protocol.FasedAgentSmsCommand

enum class InvokeCommandAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SmsAvailable,
  DebugBuild,
}

data class InvokeCommandSpec(
  val name: String,
  val requiresForeground: Boolean = false,
  val availability: InvokeCommandAvailability = InvokeCommandAvailability.Always,
)

object InvokeCommandRegistry {
  val all: List<InvokeCommandSpec> =
    listOf(
      InvokeCommandSpec(
        name = FasedAgentCanvasCommand.Present.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCanvasCommand.Hide.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCanvasCommand.Navigate.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCanvasCommand.Eval.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCanvasCommand.Snapshot.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCanvasA2UICommand.Push.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCanvasA2UICommand.PushJSONL.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCanvasA2UICommand.Reset.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentScreenCommand.Record.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = FasedAgentCameraCommand.List.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = FasedAgentCameraCommand.Snap.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = FasedAgentCameraCommand.Clip.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = FasedAgentLocationCommand.Get.rawValue,
        availability = InvokeCommandAvailability.LocationEnabled,
      ),
      InvokeCommandSpec(
        name = FasedAgentDeviceCommand.Status.rawValue,
      ),
      InvokeCommandSpec(
        name = FasedAgentDeviceCommand.Info.rawValue,
      ),
      InvokeCommandSpec(
        name = FasedAgentDeviceCommand.Permissions.rawValue,
      ),
      InvokeCommandSpec(
        name = FasedAgentDeviceCommand.Health.rawValue,
      ),
      InvokeCommandSpec(
        name = FasedAgentNotificationsCommand.List.rawValue,
      ),
      InvokeCommandSpec(
        name = FasedAgentNotificationsCommand.Actions.rawValue,
      ),
      InvokeCommandSpec(
        name = FasedAgentSmsCommand.Send.rawValue,
        availability = InvokeCommandAvailability.SmsAvailable,
      ),
      InvokeCommandSpec(
        name = "debug.logs",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
      InvokeCommandSpec(
        name = "debug.ed25519",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
      InvokeCommandSpec(name = "app.update"),
    )

  private val byNameInternal: Map<String, InvokeCommandSpec> = all.associateBy { it.name }

  fun find(command: String): InvokeCommandSpec? = byNameInternal[command]

  fun advertisedCommands(
    cameraEnabled: Boolean,
    locationEnabled: Boolean,
    smsAvailable: Boolean,
    debugBuild: Boolean,
  ): List<String> {
    return all
      .filter { spec ->
        when (spec.availability) {
          InvokeCommandAvailability.Always -> true
          InvokeCommandAvailability.CameraEnabled -> cameraEnabled
          InvokeCommandAvailability.LocationEnabled -> locationEnabled
          InvokeCommandAvailability.SmsAvailable -> smsAvailable
          InvokeCommandAvailability.DebugBuild -> debugBuild
        }
      }
      .map { it.name }
  }
}
