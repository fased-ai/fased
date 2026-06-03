import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import * as channelPluginCommon from "./channel-plugin-common.js";
import * as commandStatus from "./command-status.js";
import {
  createWebSearchProviderContractFields,
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
} from "./provider-web-search-config-contract.js";

describe("plugin-sdk subpaths", () => {
  it("exposes command status builders", () => {
    expect(typeof commandStatus.buildCommandsMessage).toBe("function");
    expect(typeof commandStatus.buildCommandsMessagePaginated).toBe("function");
    expect(typeof commandStatus.buildHelpMessage).toBe("function");
  });

  it("exposes channel plugin common helpers", () => {
    expect(typeof channelPluginCommon.buildChannelConfigSchema).toBe("function");
    expect(typeof channelPluginCommon.normalizeAccountId).toBe("function");
    expect(typeof channelPluginCommon.getChatChannelMeta).toBe("function");
  });

  it("supports provider web-search config helpers", () => {
    expect(getTopLevelCredentialValue({ apiKey: "top" })).toBe("top");
    expect(getScopedCredentialValue({ perplexity: { apiKey: "scoped" } }, "perplexity")).toBe(
      "scoped",
    );
    expect(mergeScopedSearchConfig(undefined, "perplexity", { apiKey: "merged" })).toEqual({
      perplexity: { apiKey: "merged" },
    });

    const config = {} as FasedAgentConfig;
    setProviderWebSearchPluginConfigValue(config, "perplexity-plugin", "apiKey", "cfg-key");
    expect(resolveProviderWebSearchPluginConfig(config, "perplexity-plugin")).toEqual({
      apiKey: "cfg-key",
    });

    const contract = createWebSearchProviderContractFields({
      credentialPath: "tools.web.search.perplexity.apiKey",
      searchCredential: { type: "scoped", scopeId: "perplexity" },
      configuredCredential: {
        pluginId: "perplexity-plugin",
      },
    });
    expect(contract.inactiveSecretPaths).toEqual(["tools.web.search.perplexity.apiKey"]);
    expect(contract.getCredentialValue?.({ perplexity: { apiKey: "runtime-key" } })).toBe(
      "runtime-key",
    );
    expect(contract.getConfiguredCredentialValue?.(config)).toBe("cfg-key");
  });
});
