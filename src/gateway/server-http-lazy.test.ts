import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  createGatewayHttpServer,
  type GatewayHttpServerOpts,
} from "./server-http-lazy.js";
import { getFreePort } from "./test-helpers.server.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  __testing.resetServerHttpModuleForTest();
});

function baseOpts(): GatewayHttpServerOpts {
  return {
    canvasHost: null,
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "/",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "none", allowTailscale: false },
  };
}

async function listen(server: http.Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  servers.push(server);
}

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}

describe("server-http-lazy", () => {
  it("serves live health without loading the full HTTP product handlers", async () => {
    const port = await getFreePort();
    const server = createGatewayHttpServer(baseOpts());

    await listen(server, port);
    const response = await get(port, "/health");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      status: "live",
      version: expect.any(String),
      runtimeSource: expect.any(String),
    });
    expect(__testing.isServerHttpModuleLoaded()).toBe(false);
  });

  it("delegates non-probe requests to the full HTTP handler on demand", async () => {
    const port = await getFreePort();
    const server = createGatewayHttpServer(baseOpts());

    await listen(server, port);
    const response = await get(port, "/not-found");

    expect(response.status).toBe(404);
    expect(response.body).toBe("Not Found");
    expect(__testing.isServerHttpModuleLoaded()).toBe(true);
  });
});
