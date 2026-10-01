import Foundation
import Testing
@testable import FasedAgent

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    @Test
    func `ensure file skips rewrite when unchanged`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("fased-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        // App-state tests may use the process-global store concurrently. Keep this
        // persistence assertion on its own exact file instead of changing their path.
        let url = stateDir.appendingPathComponent("exec-approvals.json")
        _ = ExecApprovalsStore.ensureFile(at: url)
        let firstWriteDate = try Self.modificationDate(at: url)
        let firstBytes = try Data(contentsOf: url)

        try await Task.sleep(nanoseconds: 1_100_000_000)
        _ = ExecApprovalsStore.ensureFile(at: url)
        let secondWriteDate = try Self.modificationDate(at: url)

        #expect(firstWriteDate == secondWriteDate)
        #expect(try Data(contentsOf: url) == firstBytes)
    }

    @Test
    func `update allowlist reports rejected basename pattern`() async {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("fased-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues(["FASED_STATE_DIR": stateDir.path]) {
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(pattern: "echo"),
                    ExecAllowlistEntry(pattern: "/bin/echo"),
                ])
            #expect(rejected.count == 1)
            #expect(rejected.first?.reason == .missingPathComponent)
            #expect(rejected.first?.pattern == "echo")

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["/bin/echo"])
        }
    }

    @Test
    func `update allowlist migrates legacy pattern from resolved path`() async {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("fased-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues(["FASED_STATE_DIR": stateDir.path]) {
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(
                        pattern: "echo",
                        lastUsedAt: nil,
                        lastUsedCommand: nil,
                        lastResolvedPath: " /usr/bin/echo "),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["/usr/bin/echo"])
        }
    }

    private static func modificationDate(at url: URL) throws -> Date {
        let attributes = try FileManager().attributesOfItem(atPath: url.path)
        guard let date = attributes[.modificationDate] as? Date else {
            struct MissingDateError: Error {}
            throw MissingDateError()
        }
        return date
    }
}
