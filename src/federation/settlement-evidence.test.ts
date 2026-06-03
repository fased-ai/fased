import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishFederationSettlementEvidence } from "./settlement-evidence.js";

let tempDir = "";

async function writeTokenFile(tokenPath: string, token: Record<string, unknown>) {
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify(token, null, 2));
}

describe("publishFederationSettlementEvidence", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-fed-settlement-"));
    vi.stubEnv("FASED_FEDERATION_BASE_URL", "https://ff1.fased.app");
    vi.stubEnv("FASED_FEDERATION_TOKEN_PATH", path.join(tempDir, "federation-token.json"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes executed settlement evidence with federation bearer auth", async () => {
    await writeTokenFile(process.env.FASED_FEDERATION_TOKEN_PATH!, {
      tokenId: "fed-token-1",
      nodeId: "node-1",
      handle: "@payer@ff1.fased.app",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["federation.read", "federation.write"],
      signature: "sig",
    });

    const fetchMock = vi.fn(async (_input: URL | string | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          status: "accepted",
          entry: {
            handle: "@payer@ff1.fased.app",
            invoiceId: "inv-1",
            txRef: "tx-1",
            status: "executed",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFederationSettlementEvidence({
      taskId: "task-1",
      invoiceId: "inv-1",
      senderHandle: "@payer@ff1.fased.app",
      txRef: "tx-1",
      chain: "solana",
      asset: {
        kind: "spl-token",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      amount: "5",
      payeeAddress: "ExamplePayeeAddress",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlValue, init] = fetchMock.mock.calls[0] ?? [];
    const requestUrl =
      typeof urlValue === "string"
        ? urlValue
        : urlValue instanceof URL
          ? urlValue.toString()
          : urlValue instanceof Request
            ? urlValue.url
            : "";
    expect(requestUrl).toBe("https://ff1.fased.app/api/federation/settlements");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer fed-token-1",
      "Content-Type": "application/json",
    });
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
    expect(JSON.parse(bodyText)).toMatchObject({
      taskId: "task-1",
      invoiceId: "inv-1",
      txRef: "tx-1",
      chain: "solana",
      asset: {
        kind: "spl-token",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      amount: "5",
      payee: {
        chain: "solana",
        address: "ExamplePayeeAddress",
      },
      status: "executed",
    });
  });

  it("rejects local publish when senderHandle does not match the persisted federation token", async () => {
    await writeTokenFile(process.env.FASED_FEDERATION_TOKEN_PATH!, {
      tokenId: "fed-token-2",
      nodeId: "node-2",
      handle: "@payer@ff1.fased.app",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["federation.read", "federation.write"],
      signature: "sig",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFederationSettlementEvidence({
      invoiceId: "inv-2",
      senderHandle: "@other@ff1.fased.app",
      txRef: "tx-2",
      chain: "solana",
      asset: {
        kind: "native",
      },
      amount: "7",
      payeeAddress: "ExamplePayeeAddress",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "federation_handle_mismatch",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
