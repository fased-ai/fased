import Foundation
import FasedAgentKit
import UIKit

final class DeviceStatusService: DeviceStatusServicing {
    private let networkStatus: NetworkStatusService

    init(networkStatus: NetworkStatusService = NetworkStatusService()) {
        self.networkStatus = networkStatus
    }

    func status() async throws -> FasedAgentDeviceStatusPayload {
        let battery = self.batteryStatus()
        let thermal = self.thermalStatus()
        let storage = self.storageStatus()
        let network = await self.networkStatus.currentStatus()
        let uptime = ProcessInfo.processInfo.systemUptime

        return FasedAgentDeviceStatusPayload(
            battery: battery,
            thermal: thermal,
            storage: storage,
            network: network,
            uptimeSeconds: uptime)
    }

    func info() -> FasedAgentDeviceInfoPayload {
        let device = UIDevice.current
        let appVersion = DeviceInfoHelper.appVersion()
        let appBuild = DeviceStatusService.fallbackAppBuild(DeviceInfoHelper.appBuild())
        let locale = Locale.preferredLanguages.first ?? Locale.current.identifier
        return FasedAgentDeviceInfoPayload(
            deviceName: device.name,
            modelIdentifier: DeviceInfoHelper.modelIdentifier(),
            systemName: device.systemName,
            systemVersion: device.systemVersion,
            appVersion: appVersion,
            appBuild: appBuild,
            locale: locale)
    }

    private func batteryStatus() -> FasedAgentBatteryStatusPayload {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let level = device.batteryLevel >= 0 ? Double(device.batteryLevel) : nil
        let state: FasedAgentBatteryState = switch device.batteryState {
        case .charging: .charging
        case .full: .full
        case .unplugged: .unplugged
        case .unknown: .unknown
        @unknown default: .unknown
        }
        return FasedAgentBatteryStatusPayload(
            level: level,
            state: state,
            lowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled)
    }

    private func thermalStatus() -> FasedAgentThermalStatusPayload {
        let state: FasedAgentThermalState = switch ProcessInfo.processInfo.thermalState {
        case .nominal: .nominal
        case .fair: .fair
        case .serious: .serious
        case .critical: .critical
        @unknown default: .nominal
        }
        return FasedAgentThermalStatusPayload(state: state)
    }

    private func storageStatus() -> FasedAgentStorageStatusPayload {
        let attrs = (try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())) ?? [:]
        let total = (attrs[.systemSize] as? NSNumber)?.int64Value ?? 0
        let free = (attrs[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        let used = max(0, total - free)
        return FasedAgentStorageStatusPayload(totalBytes: total, freeBytes: free, usedBytes: used)
    }

    /// Fallback for payloads that require a non-empty build (e.g. "0").
    private static func fallbackAppBuild(_ build: String) -> String {
        build.isEmpty ? "0" : build
    }
}
