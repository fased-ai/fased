package ai.fased.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class FasedAgentProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", FasedAgentCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", FasedAgentCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", FasedAgentCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", FasedAgentCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", FasedAgentCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", FasedAgentCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", FasedAgentCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", FasedAgentCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", FasedAgentCapability.Canvas.rawValue)
    assertEquals("camera", FasedAgentCapability.Camera.rawValue)
    assertEquals("screen", FasedAgentCapability.Screen.rawValue)
    assertEquals("voiceWake", FasedAgentCapability.VoiceWake.rawValue)
    assertEquals("location", FasedAgentCapability.Location.rawValue)
    assertEquals("sms", FasedAgentCapability.Sms.rawValue)
    assertEquals("device", FasedAgentCapability.Device.rawValue)
  }

  @Test
  fun cameraCommandsUseStableStrings() {
    assertEquals("camera.list", FasedAgentCameraCommand.List.rawValue)
    assertEquals("camera.snap", FasedAgentCameraCommand.Snap.rawValue)
    assertEquals("camera.clip", FasedAgentCameraCommand.Clip.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", FasedAgentScreenCommand.Record.rawValue)
  }

  @Test
  fun notificationsCommandsUseStableStrings() {
    assertEquals("notifications.list", FasedAgentNotificationsCommand.List.rawValue)
    assertEquals("notifications.actions", FasedAgentNotificationsCommand.Actions.rawValue)
  }

  @Test
  fun deviceCommandsUseStableStrings() {
    assertEquals("device.status", FasedAgentDeviceCommand.Status.rawValue)
    assertEquals("device.info", FasedAgentDeviceCommand.Info.rawValue)
    assertEquals("device.permissions", FasedAgentDeviceCommand.Permissions.rawValue)
    assertEquals("device.health", FasedAgentDeviceCommand.Health.rawValue)
  }
}
