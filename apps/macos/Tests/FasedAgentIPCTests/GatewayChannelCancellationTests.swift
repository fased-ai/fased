import FasedAgentKit
import Foundation
import os
import Testing

@Suite(.serialized) struct GatewayChannelCancellationTests {
    private final class RepeatingSocket: WebSocketTasking, @unchecked Sendable {
        private let responsePhase: Bool
        private let receives = OSAllocatedUnfairLock(initialState: 0)
        private let connectSent = OSAllocatedUnfairLock(initialState: false)
        var state: URLSessionTask.State = .suspended

        init(responsePhase: Bool) {
            self.responsePhase = responsePhase
        }

        func receiveCount() -> Int {
            self.receives.withLock { $0 }
        }

        func resume() {
            self.state = .running
        }

        func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            self.state = .canceling
        }

        func send(_ message: URLSessionWebSocketTask.Message) async throws {
            self.connectSent.withLock { $0 = true }
        }

        func receive() async throws -> URLSessionWebSocketTask.Message {
            self.receives.withLock { $0 += 1 }
            await Task.yield()
            if self.responsePhase, !self.connectSent.withLock({ $0 }) {
                return .data(GatewayWebSocketTestSupport.connectChallengeData())
            }
            // Valid unrelated responses must not keep a cancelled handshake alive.
            return .data(GatewayWebSocketTestSupport.connectOkData(id: "unrelated-request"))
        }

        func receive(
            completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
        {}
    }

    private final class Session: WebSocketSessioning, @unchecked Sendable {
        let socket: RepeatingSocket
        init(socket: RepeatingSocket) {
            self.socket = socket
        }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            WebSocketTaskBox(task: self.socket)
        }
    }

    @Test func `cancellation stops repeated non challenge frames`() async throws {
        try await self.checkCancellation(responsePhase: false)
    }

    @Test func `cancellation stops repeated unrelated responses`() async throws {
        try await self.checkCancellation(responsePhase: true)
    }

    private func checkCancellation(responsePhase: Bool) async throws {
        let socket = RepeatingSocket(responsePhase: responsePhase)
        let options = GatewayConnectOptions(
            role: "operator", scopes: [], caps: [], commands: [], permissions: [:],
            clientId: "test", clientMode: "test", clientDisplayName: nil, includeDeviceIdentity: false)
        let channel = GatewayChannelActor(
            url: URL(string: "ws://example.invalid")!, token: nil,
            session: WebSocketSessionBox(session: Session(socket: socket)), connectOptions: options)
        let attempt = Task { try await channel.connect() }
        for _ in 0..<100 where socket.receiveCount() < 3 {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(socket.receiveCount() >= 3)
        attempt.cancel()
        let result = await attempt.result
        if case .success = result {
            Issue.record("Cancelled handshake unexpectedly connected")
        }
        let stoppedCount = socket.receiveCount()
        try await Task.sleep(nanoseconds: 10_000_000)
        #expect(socket.receiveCount() == stoppedCount)
        await channel.shutdown()
    }
}
