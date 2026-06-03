import Darwin
import Foundation
import Testing
@testable import FasedAgent

@Suite(.serialized) struct CommandResolverTests {
    private func makeDefaults() -> UserDefaults {
        // Use a unique suite to avoid cross-suite concurrency on UserDefaults.standard.
        UserDefaults(suiteName: "CommandResolverTests.\(UUID().uuidString)")!
    }

    private func makeTempDir() throws -> URL {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makeExec(at path: URL) throws {
        try FileManager().createDirectory(
            at: path.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        FileManager().createFile(atPath: path.path, contents: Data("echo ok\n".utf8))
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
    }

    @Test func prefersFasedAgentBinary() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let fasedPath = tmp.appendingPathComponent("node_modules/.bin/fased")
        try self.makeExec(at: fasedPath)

        let cmd = CommandResolver.fasedCommand(subcommand: "gateway", defaults: defaults, configRoot: [:])
        #expect(cmd.prefix(2).elementsEqual([fasedPath.path, "gateway"]))
    }

    @Test func fallsBackToNodeAndScript() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let nodePath = tmp.appendingPathComponent("node_modules/.bin/node")
        let scriptPath = tmp.appendingPathComponent("bin/fased.js")
        try self.makeExec(at: nodePath)
        try "#!/bin/sh\necho v22.0.0\n".write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)
        try self.makeExec(at: scriptPath)

        let cmd = CommandResolver.fasedCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0] == nodePath.path)
            #expect(cmd[1] == scriptPath.path)
            #expect(cmd[2] == "rpc")
        }
    }

    @Test func prefersFasedAgentBinaryOverPnpm() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let binDir = tmp.appendingPathComponent("bin")
        let fasedPath = binDir.appendingPathComponent("fased")
        let pnpmPath = binDir.appendingPathComponent("pnpm")
        try self.makeExec(at: fasedPath)
        try self.makeExec(at: pnpmPath)

        let cmd = CommandResolver.fasedCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path])

        #expect(cmd.prefix(2).elementsEqual([fasedPath.path, "rpc"]))
    }

    @Test func usesFasedAgentBinaryWithoutNodeRuntime() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let binDir = tmp.appendingPathComponent("bin")
        let fasedPath = binDir.appendingPathComponent("fased")
        try self.makeExec(at: fasedPath)

        let cmd = CommandResolver.fasedCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path])

        #expect(cmd.prefix(2).elementsEqual([fasedPath.path, "gateway"]))
    }

    @Test func fallsBackToPnpm() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try self.makeExec(at: pnpmPath)

        let cmd = CommandResolver.fasedCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.prefix(4).elementsEqual([pnpmPath.path, "--silent", "fased", "rpc"]))
    }

    @Test func pnpmKeepsExtraArgsAfterSubcommand() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try self.makeExec(at: pnpmPath)

        let cmd = CommandResolver.fasedCommand(
            subcommand: "health",
            extraArgs: ["--json", "--timeout", "5"],
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.prefix(5).elementsEqual([pnpmPath.path, "--silent", "fased", "health", "--json"]))
        #expect(cmd.suffix(2).elementsEqual(["--timeout", "5"]))
    }

    @Test func preferredPathsStartWithProjectNodeBins() async throws {
        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let first = CommandResolver.preferredPaths().first
        #expect(first == tmp.appendingPathComponent("node_modules/.bin").path)
    }

    @Test func buildsSSHCommandForRemoteMode() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("fased@example.com:2222", forKey: remoteTargetKey)
        defaults.set("/tmp/id_ed25519", forKey: remoteIdentityKey)
        defaults.set("/srv/fased", forKey: remoteProjectRootKey)

        let cmd = CommandResolver.fasedCommand(
            subcommand: "status",
            extraArgs: ["--json"],
            defaults: defaults,
            configRoot: [:])

        #expect(cmd.first == "/usr/bin/ssh")
        if let marker = cmd.firstIndex(of: "--") {
            #expect(cmd[marker + 1] == "fased@example.com")
        } else {
            #expect(Bool(false))
        }
        #expect(cmd.contains("-i"))
        #expect(cmd.contains("/tmp/id_ed25519"))
        if let script = cmd.last {
            #expect(script.contains("PRJ='/srv/fased'"))
            #expect(script.contains("cd \"$PRJ\""))
            #expect(script.contains("fased"))
            #expect(script.contains("status"))
            #expect(script.contains("--json"))
            #expect(script.contains("CLI="))
        }
    }

    @Test func rejectsUnsafeSSHTargets() async throws {
        #expect(CommandResolver.parseSSHTarget("-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("host:-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("user@host:2222")?.port == 2222)
    }

    @Test func configRootLocalOverridesRemoteDefaults() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("fased@example.com:2222", forKey: remoteTargetKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let fasedPath = tmp.appendingPathComponent("node_modules/.bin/fased")
        try self.makeExec(at: fasedPath)

        let cmd = CommandResolver.fasedCommand(
            subcommand: "daemon",
            defaults: defaults,
            configRoot: ["gateway": ["mode": "local"]])

        #expect(cmd.first == fasedPath.path)
        #expect(cmd.count >= 2)
        if cmd.count >= 2 {
            #expect(cmd[1] == "daemon")
        }
    }
}
