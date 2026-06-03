package ai.fased.android.node

import ai.fased.android.protocol.FasedAgentCameraCommand
import ai.fased.android.protocol.FasedAgentDeviceCommand
import ai.fased.android.protocol.FasedAgentLocationCommand
import ai.fased.android.protocol.FasedAgentNotificationsCommand
import ai.fased.android.protocol.FasedAgentSmsCommand
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  @Test
  fun advertisedCommands_respectsFeatureAvailability() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        cameraEnabled = false,
        locationEnabled = false,
        smsAvailable = false,
        debugBuild = false,
      )

    assertFalse(commands.contains(FasedAgentCameraCommand.Snap.rawValue))
    assertFalse(commands.contains(FasedAgentCameraCommand.Clip.rawValue))
    assertFalse(commands.contains(FasedAgentCameraCommand.List.rawValue))
    assertFalse(commands.contains(FasedAgentLocationCommand.Get.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(FasedAgentNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(FasedAgentNotificationsCommand.Actions.rawValue))
    assertFalse(commands.contains(FasedAgentSmsCommand.Send.rawValue))
    assertFalse(commands.contains("debug.logs"))
    assertFalse(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }

  @Test
  fun advertisedCommands_includesFeatureCommandsWhenEnabled() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        cameraEnabled = true,
        locationEnabled = true,
        smsAvailable = true,
        debugBuild = true,
      )

    assertTrue(commands.contains(FasedAgentCameraCommand.Snap.rawValue))
    assertTrue(commands.contains(FasedAgentCameraCommand.Clip.rawValue))
    assertTrue(commands.contains(FasedAgentCameraCommand.List.rawValue))
    assertTrue(commands.contains(FasedAgentLocationCommand.Get.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Status.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Info.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Permissions.rawValue))
    assertTrue(commands.contains(FasedAgentDeviceCommand.Health.rawValue))
    assertTrue(commands.contains(FasedAgentNotificationsCommand.List.rawValue))
    assertTrue(commands.contains(FasedAgentNotificationsCommand.Actions.rawValue))
    assertTrue(commands.contains(FasedAgentSmsCommand.Send.rawValue))
    assertTrue(commands.contains("debug.logs"))
    assertTrue(commands.contains("debug.ed25519"))
    assertTrue(commands.contains("app.update"))
  }
}
