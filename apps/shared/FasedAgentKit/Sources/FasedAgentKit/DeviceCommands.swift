import Foundation

public enum FasedAgentDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum FasedAgentBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum FasedAgentThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum FasedAgentNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum FasedAgentNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct FasedAgentBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: FasedAgentBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: FasedAgentBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct FasedAgentThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: FasedAgentThermalState

    public init(state: FasedAgentThermalState) {
        self.state = state
    }
}

public struct FasedAgentStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct FasedAgentNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: FasedAgentNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [FasedAgentNetworkInterfaceType]

    public init(
        status: FasedAgentNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [FasedAgentNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct FasedAgentDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: FasedAgentBatteryStatusPayload
    public var thermal: FasedAgentThermalStatusPayload
    public var storage: FasedAgentStorageStatusPayload
    public var network: FasedAgentNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: FasedAgentBatteryStatusPayload,
        thermal: FasedAgentThermalStatusPayload,
        storage: FasedAgentStorageStatusPayload,
        network: FasedAgentNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct FasedAgentDeviceInfoPayload: Codable, Sendable, Equatable {
    public var deviceName: String
    public var modelIdentifier: String
    public var systemName: String
    public var systemVersion: String
    public var appVersion: String
    public var appBuild: String
    public var locale: String

    public init(
        deviceName: String,
        modelIdentifier: String,
        systemName: String,
        systemVersion: String,
        appVersion: String,
        appBuild: String,
        locale: String)
    {
        self.deviceName = deviceName
        self.modelIdentifier = modelIdentifier
        self.systemName = systemName
        self.systemVersion = systemVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }
}
