import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { GatewayModelChoice } from "./server-model-catalog.js";
import {
  __resetModelCatalogCacheForTest,
  loadGatewayModelCatalog,
  markGatewayModelCatalogStaleForReload,
} from "./server-model-catalog.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type LoadModelCatalogForTest = NonNullable<
  NonNullable<Parameters<typeof loadGatewayModelCatalog>[0]>["loadModelCatalog"]
>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function model(id: string): GatewayModelChoice {
  return { id, name: id, provider: "openai" };
}

function configModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

const config = {
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [configModel("gpt-5.5")],
      },
    },
  },
} satisfies FasedAgentConfig;

const getConfig = () => config;

describe("loadGatewayModelCatalog", () => {
  beforeEach(() => {
    __resetModelCatalogCacheForTest();
  });

  it("caches the first successful read-only catalog until reload marks it stale", async () => {
    const catalog = [model("gpt-5.5")];
    const loadModelCatalog = vi.fn<LoadModelCatalogForTest>(async () => catalog);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(catalog);
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(catalog);

    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
    expect(loadModelCatalog).toHaveBeenCalledWith({
      config,
      readOnly: true,
      useCache: false,
    });
  });

  it("keeps read-only and full catalog caches separate without changing model row shape", async () => {
    const readOnlyCatalog = [model("configured-only")];
    const fullCatalog = [model("configured-only"), model("browse-only")];
    const loadModelCatalog = vi.fn<LoadModelCatalogForTest>(async (params) =>
      params.readOnly === false ? fullCatalog : readOnlyCatalog,
    );

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      readOnlyCatalog,
    );
    await expect(
      loadGatewayModelCatalog({ getConfig, loadModelCatalog, readOnly: false }),
    ).resolves.toBe(fullCatalog);
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      readOnlyCatalog,
    );

    expect(loadModelCatalog).toHaveBeenCalledTimes(2);
    expect(loadModelCatalog).toHaveBeenNthCalledWith(1, {
      config,
      readOnly: true,
      useCache: false,
    });
    expect(loadModelCatalog).toHaveBeenNthCalledWith(2, {
      config,
      readOnly: false,
      useCache: false,
    });
    expect(readOnlyCatalog[0]).toEqual({
      id: "configured-only",
      name: "configured-only",
      provider: "openai",
    });
  });

  it("caches an empty read-only catalog until reload marks it stale", async () => {
    const emptyCatalog: GatewayModelChoice[] = [];
    const freshCatalog = [model("gpt-5.5")];
    const loadModelCatalog = vi
      .fn<LoadModelCatalogForTest>()
      .mockResolvedValueOnce(emptyCatalog)
      .mockResolvedValueOnce(freshCatalog);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      emptyCatalog,
    );
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      emptyCatalog,
    );

    expect(loadModelCatalog).toHaveBeenCalledTimes(1);

    markGatewayModelCatalogStaleForReload();
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      emptyCatalog,
    );
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
        freshCatalog,
      );
    });
  });

  it("does not cache an empty full catalog so the next all-model request retries", async () => {
    const emptyCatalog: GatewayModelChoice[] = [];
    const freshCatalog = [model("gpt-5.5")];
    const loadModelCatalog = vi
      .fn<LoadModelCatalogForTest>()
      .mockResolvedValueOnce(emptyCatalog)
      .mockResolvedValueOnce(freshCatalog);

    await expect(
      loadGatewayModelCatalog({ getConfig, loadModelCatalog, readOnly: false }),
    ).resolves.toBe(emptyCatalog);
    await expect(
      loadGatewayModelCatalog({ getConfig, loadModelCatalog, readOnly: false }),
    ).resolves.toBe(freshCatalog);

    expect(loadModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("returns the last catalog while a stale reload refresh is still pending", async () => {
    const staleCatalog = [model("gpt-5.4")];
    const freshCatalog = [model("gpt-5.5")];
    const refresh = createDeferred<GatewayModelChoice[]>();
    const loadModelCatalog = vi
      .fn<LoadModelCatalogForTest>()
      .mockResolvedValueOnce(staleCatalog)
      .mockReturnValueOnce(refresh.promise);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );

    markGatewayModelCatalogStaleForReload();
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(2));

    refresh.resolve(freshCatalog);
    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
        freshCatalog,
      );
    });
  });

  it("keeps serving the last catalog when a stale background refresh fails", async () => {
    const staleCatalog = [model("gpt-5.4")];
    const freshCatalog = [model("gpt-5.5")];
    const loadModelCatalog = vi
      .fn<LoadModelCatalogForTest>()
      .mockResolvedValueOnce(staleCatalog)
      .mockRejectedValueOnce(new Error("provider offline"))
      .mockResolvedValueOnce(freshCatalog);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );

    markGatewayModelCatalogStaleForReload();
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(2));

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(3));

    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
        freshCatalog,
      );
    });
  });
});
