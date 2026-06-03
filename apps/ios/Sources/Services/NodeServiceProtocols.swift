import CoreLocation
import Foundation
import FasedAgentKit
import UIKit

typealias FasedAgentCameraSnapResult = (format: String, base64: String, width: Int, height: Int)
typealias FasedAgentCameraClipResult = (format: String, base64: String, durationMs: Int, hasAudio: Bool)

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: FasedAgentCameraSnapParams) async throws -> FasedAgentCameraSnapResult
    func clip(params: FasedAgentCameraClipParams) async throws -> FasedAgentCameraClipResult
}

protocol ScreenRecordingServicing: Sendable {
    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
}

@MainActor
protocol LocationServicing: Sendable {
    func authorizationStatus() -> CLAuthorizationStatus
    func accuracyAuthorization() -> CLAccuracyAuthorization
    func ensureAuthorization(mode: FasedAgentLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: FasedAgentLocationGetParams,
        desiredAccuracy: FasedAgentLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    func startLocationUpdates(
        desiredAccuracy: FasedAgentLocationAccuracy,
        significantChangesOnly: Bool) -> AsyncStream<CLLocation>
    func stopLocationUpdates()
    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void)
    func stopMonitoringSignificantLocationChanges()
}

protocol DeviceStatusServicing: Sendable {
    func status() async throws -> FasedAgentDeviceStatusPayload
    func info() -> FasedAgentDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: FasedAgentPhotosLatestParams) async throws -> FasedAgentPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: FasedAgentContactsSearchParams) async throws -> FasedAgentContactsSearchPayload
    func add(params: FasedAgentContactsAddParams) async throws -> FasedAgentContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: FasedAgentCalendarEventsParams) async throws -> FasedAgentCalendarEventsPayload
    func add(params: FasedAgentCalendarAddParams) async throws -> FasedAgentCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: FasedAgentRemindersListParams) async throws -> FasedAgentRemindersListPayload
    func add(params: FasedAgentRemindersAddParams) async throws -> FasedAgentRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: FasedAgentMotionActivityParams) async throws -> FasedAgentMotionActivityPayload
    func pedometer(params: FasedAgentPedometerParams) async throws -> FasedAgentPedometerPayload
}

struct WatchMessagingStatus: Sendable, Equatable {
    var supported: Bool
    var paired: Bool
    var appInstalled: Bool
    var reachable: Bool
    var activationState: String
}

struct WatchQuickReplyEvent: Sendable, Equatable {
    var replyId: String
    var promptId: String
    var actionId: String
    var actionLabel: String?
    var sessionKey: String?
    var note: String?
    var sentAtMs: Int?
    var transport: String
}

struct WatchNotificationSendResult: Sendable, Equatable {
    var deliveredImmediately: Bool
    var queuedForDelivery: Bool
    var transport: String
}

protocol WatchMessagingServicing: AnyObject, Sendable {
    func status() async -> WatchMessagingStatus
    func setReplyHandler(_ handler: (@Sendable (WatchQuickReplyEvent) -> Void)?)
    func sendNotification(
        id: String,
        params: FasedAgentWatchNotifyParams) async throws -> WatchNotificationSendResult
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
