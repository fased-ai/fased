import Foundation

public enum FasedAgentLocationMode: String, Codable, Sendable, CaseIterable {
    case off
    case whileUsing
    case always
}
