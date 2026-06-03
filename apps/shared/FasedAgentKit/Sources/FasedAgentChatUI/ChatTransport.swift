import Foundation

public enum FasedAgentChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(FasedAgentChatEventPayload)
    case agent(FasedAgentAgentEventPayload)
    case seqGap
}

public protocol FasedAgentChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> FasedAgentChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [FasedAgentChatAttachmentPayload]) async throws -> FasedAgentChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> FasedAgentChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<FasedAgentChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension FasedAgentChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "FasedAgentChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> FasedAgentChatSessionsListResponse {
        throw NSError(
            domain: "FasedAgentChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
