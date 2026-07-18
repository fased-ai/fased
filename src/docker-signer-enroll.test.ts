import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerSignerEnrollmentProxy } from "../scripts/docker-signer-enroll.mjs";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listenLocal(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind TCP");
  }
  return address.port;
}

describe("Docker signer enrollment proxy", () => {
  it("relays only to the signer-local enrollment listener", async () => {
    const backend = net.createServer((socket) => {
      socket.once("data", (data) => socket.end(`signer:${data.toString("utf8")}`));
    });
    servers.push(backend);
    const backendPort = await listenLocal(backend);
    const proxy = createDockerSignerEnrollmentProxy({ backendPort });
    servers.push(proxy);
    const proxyPort = await listenLocal(proxy);

    const response = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection({ host: "127.0.0.1", port: proxyPort });
      let body = "";
      client.setEncoding("utf8");
      client.once("connect", () => client.write("challenge"));
      client.on("data", (chunk) => {
        body += chunk;
      });
      client.once("end", () => resolve(body));
      client.once("error", reject);
    });

    expect(response).toBe("signer:challenge");
  });
});
