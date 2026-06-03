import Foundation
import Network
import OSLog

final class WalletCustodyCompanionBridge {
    static let shared = WalletCustodyCompanionBridge()

    private let logger = Logger(subsystem: "ai.fased", category: "wallet-custody-companion")
    private let queue = DispatchQueue(label: "ai.fased.wallet-custody-companion", qos: .utility)
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let keychainStore = WalletCustodyCompanionKeychainStore.shared

    private var listener: NWListener?

    private init() {}

    func start() {
        self.queue.async {
            self.startLocked()
        }
    }

    func stop() {
        self.queue.async {
            self.listener?.cancel()
            self.listener = nil
        }
    }

    private func startLocked() {
        guard self.listener == nil else { return }
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            let port = NWEndpoint.Port(rawValue: WalletCustodyCompanionProtocol.port)!
            parameters.requiredLocalEndpoint = .hostPort(
                host: NWEndpoint.Host(WalletCustodyCompanionProtocol.host),
                port: port)
            let listener = try NWListener(using: parameters)
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection)
            }
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.logger.info(
                        "Wallet custody companion bridge ready on \(WalletCustodyCompanionProtocol.host):\(WalletCustodyCompanionProtocol.port)")
                case let .failed(error):
                    self?.logger.error("Wallet custody companion bridge failed: \(error, privacy: .public)")
                    self?.listener = nil
                default:
                    break
                }
            }
            listener.start(queue: self.queue)
            self.listener = listener
        } catch {
            self.logger.error("Wallet custody companion bridge start failed: \(error, privacy: .public)")
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: self.queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, error in
            guard let self else {
                connection.cancel()
                return
            }
            if let error {
                self.logger.debug("Wallet custody companion receive failed: \(error, privacy: .public)")
                connection.cancel()
                return
            }
            guard let data, !data.isEmpty else {
                connection.cancel()
                return
            }
            self.respond(to: connection, requestData: data)
        }
    }

    private func respond(to connection: NWConnection, requestData: Data) {
        guard let requestLine = String(data: requestData, encoding: .utf8)?
            .components(separatedBy: "\r\n")
            .first
        else {
            self.sendText(status: "400 Bad Request", text: "invalid request", to: connection)
            return
        }
        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 2 else {
            self.sendText(status: "400 Bad Request", text: "invalid request line", to: connection)
            return
        }
        let method = String(parts[0]).uppercased()
        let rawTarget = String(parts[1])
        let target = self.parseTarget(rawTarget)
        let path = target?.path ?? rawTarget

        switch (method, path) {
        case ("OPTIONS", _):
            self.send(status: "204 No Content", contentType: "text/plain; charset=utf-8", body: Data(), to: connection)
        case ("GET", WalletCustodyCompanionProtocol.healthPath):
            let response = WalletCustodyCompanionProtocol.HealthResponse(
                ok: true,
                protocolVersion: WalletCustodyCompanionProtocol.protocolVersion,
                helper: WalletCustodyCompanionProtocol.helperName,
                platform: "macos",
                storageMode: "os-keychain",
                availableRoutes: WalletCustodyCompanionProtocol.availableRoutes,
                storedWalletCount: self.keychainStore.storedWalletCount())
            do {
                let body = try self.encoder.encode(response)
                self.send(status: "200 OK", contentType: "application/json; charset=utf-8", body: body, to: connection)
            } catch {
                self.sendText(status: "500 Internal Server Error", text: "encode failure", to: connection)
            }
        case ("GET", WalletCustodyCompanionProtocol.deviceShareStatusPath):
            let gatewayOrigin = target?.query["gatewayOrigin"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let walletId = target?.query["walletId"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !gatewayOrigin.isEmpty, !walletId.isEmpty else {
                self.sendText(status: "400 Bad Request", text: "gatewayOrigin and walletId are required", to: connection)
                return
            }
            let response = WalletCustodyCompanionProtocol.DeviceShareStatusResponse(
                ok: true,
                stored: self.keychainStore.hasStoredShare(gatewayOrigin: gatewayOrigin, walletId: walletId))
            self.sendJson(response, to: connection)
        case ("POST", WalletCustodyCompanionProtocol.deviceShareStorePath):
            do {
                let request = try self.decodeBody(
                    WalletCustodyCompanionProtocol.DeviceShareStoreRequest.self,
                    from: requestData)
                let now = ISO8601DateFormatter().string(from: Date())
                let record = WalletCustodyCompanionStoredShareRecord(
                    version: 1,
                    gatewayOrigin: request.gatewayOrigin,
                    walletId: request.walletId,
                    deviceShare: request.deviceShare,
                    credentialId: request.credentialId,
                    deviceLabel: request.deviceLabel,
                    createdAt: now,
                    updatedAt: now)
                try self.keychainStore.save(record)
                self.sendJson(
                    WalletCustodyCompanionProtocol.DeviceShareStoreResponse(
                        ok: true,
                        stored: true,
                        storageMode: "os-keychain"),
                    to: connection)
            } catch {
                self.logger.error("Wallet custody companion store failed: \(error, privacy: .public)")
                self.sendText(status: "500 Internal Server Error", text: String(describing: error), to: connection)
            }
        case ("POST", WalletCustodyCompanionProtocol.deviceShareLoadPath):
            do {
                let request = try self.decodeBody(
                    WalletCustodyCompanionProtocol.DeviceShareLoadRequest.self,
                    from: requestData)
                let prompt = request.prompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                    ? request.prompt!.trimmingCharacters(in: .whitespacesAndNewlines)
                    : "Authenticate to release the stored device share for \(request.walletId)."
                guard let record = try self.keychainStore.load(
                    gatewayOrigin: request.gatewayOrigin,
                    walletId: request.walletId,
                    prompt: prompt)
                else {
                    self.sendText(status: "404 Not Found", text: "device share not found", to: connection)
                    return
                }
                self.sendJson(
                    WalletCustodyCompanionProtocol.DeviceShareLoadResponse(
                        ok: true,
                        deviceShare: record.deviceShare),
                    to: connection)
            } catch {
                self.logger.error("Wallet custody companion load failed: \(error, privacy: .public)")
                self.sendText(status: "500 Internal Server Error", text: String(describing: error), to: connection)
            }
        case ("POST", WalletCustodyCompanionProtocol.deviceShareDeletePath):
            do {
                let request = try self.decodeBody(
                    WalletCustodyCompanionProtocol.DeviceShareDeleteRequest.self,
                    from: requestData)
                let removed = self.keychainStore.delete(
                    gatewayOrigin: request.gatewayOrigin,
                    walletId: request.walletId)
                self.sendJson(
                    WalletCustodyCompanionProtocol.DeviceShareDeleteResponse(
                        ok: true,
                        removed: removed),
                    to: connection)
            } catch {
                self.logger.error("Wallet custody companion delete failed: \(error, privacy: .public)")
                self.sendText(status: "500 Internal Server Error", text: String(describing: error), to: connection)
            }
        default:
            self.sendText(status: "404 Not Found", text: "not found", to: connection)
        }
    }

    private func parseTarget(_ rawTarget: String) -> (path: String, query: [String: String])? {
        guard let components = URLComponents(string: "http://\(WalletCustodyCompanionProtocol.host)\(rawTarget)") else {
            return nil
        }
        let query = Dictionary(
            uniqueKeysWithValues: (components.queryItems ?? []).map { item in
                (item.name, item.value ?? "")
            })
        return (components.path, query)
    }

    private func decodeBody<T: Decodable>(_ type: T.Type, from requestData: Data) throws -> T {
        let separator = Data("\r\n\r\n".utf8)
        guard let range = requestData.range(of: separator) else {
            throw NSError(
                domain: "WalletCustodyCompanionBridge",
                code: 400,
                userInfo: [NSLocalizedDescriptionKey: "Request body missing"])
        }
        let body = requestData.subdata(in: range.upperBound..<requestData.endIndex)
        return try self.decoder.decode(type, from: body)
    }

    private func sendJson<T: Encodable>(_ value: T, to connection: NWConnection) {
        do {
            let body = try self.encoder.encode(value)
            self.send(status: "200 OK", contentType: "application/json; charset=utf-8", body: body, to: connection)
        } catch {
            self.sendText(status: "500 Internal Server Error", text: "encode failure", to: connection)
        }
    }

    private func sendText(status: String, text: String, to connection: NWConnection) {
        let body = Data(text.utf8)
        self.send(status: status, contentType: "text/plain; charset=utf-8", body: body, to: connection)
    }

    private func send(status: String, contentType: String, body: Data, to connection: NWConnection) {
        var response = "HTTP/1.1 \(status)\r\n"
        response += "Content-Type: \(contentType)\r\n"
        response += "Content-Length: \(body.count)\r\n"
        response += "Access-Control-Allow-Origin: *\r\n"
        response += "Access-Control-Allow-Headers: Accept, Content-Type\r\n"
        response += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        response += "Cache-Control: no-store\r\n"
        response += "Connection: close\r\n"
        response += "\r\n"

        var payload = Data(response.utf8)
        payload.append(body)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
