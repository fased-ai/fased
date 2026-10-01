import FasedAgentIPC
import Foundation
import os

enum ShellExecutor {
    struct ShellResult {
        var stdout: String
        var stderr: String
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var errorMessage: String?
    }

    static func runDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?) async -> ShellResult
    {
        guard !command.isEmpty else {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "empty command")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = command
        if let cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }
        if let env {
            process.environment = env
        }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "failed to start: \(error.localizedDescription)")
        }

        let timedOut = OSAllocatedUnfairLock(initialState: false)
        let outTask = Task {
            await self.runBlocking { stdoutPipe.fileHandleForReading.readToEndSafely() }
        }
        let errTask = Task {
            await self.runBlocking { stderrPipe.fileHandleForReading.readToEndSafely() }
        }

        let waitTask = Task { () -> ShellResult in
            await self.runBlocking { process.waitUntilExit() }
            let out = await outTask.value
            let err = await errTask.value
            let status = Int(process.terminationStatus)
            if timedOut.withLock({ $0 }) {
                return ShellResult(
                    stdout: "", stderr: "", exitCode: nil, timedOut: true,
                    success: false, errorMessage: "timeout")
            }
            return ShellResult(
                stdout: String(bytes: out, encoding: .utf8) ?? "",
                stderr: String(bytes: err, encoding: .utf8) ?? "",
                exitCode: status,
                timedOut: false,
                success: status == 0,
                errorMessage: status == 0 ? nil : "exit \(status)")
        }

        if let timeout, timeout > 0 {
            let nanos = UInt64(timeout * 1_000_000_000)
            return await withTaskGroup(of: ShellResult.self) { group in
                group.addTask { await waitTask.value }
                group.addTask {
                    do {
                        try await Task.sleep(nanoseconds: nanos)
                    } catch {
                        return await waitTask.value
                    }
                    if process.isRunning {
                        // Both race participants must report the same timeout outcome.
                        timedOut.withLock { $0 = true }
                        process.terminate()
                    }
                    return await waitTask.value // drain pipes after termination
                }
                let first = await group.next()!
                group.cancelAll()
                return first
            }
        }

        return await waitTask.value
    }

    private static func runBlocking<T: Sendable>(
        _ operation: @escaping @Sendable () -> T) async -> T
    {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: operation())
            }
        }
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}
