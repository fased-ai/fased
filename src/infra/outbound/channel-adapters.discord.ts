import { Separator, TextDisplay } from "@buape/carbon";
import { DiscordUiContainer } from "../../discord/ui.js";
import type { ChannelMessageAdapter } from "./channel-adapters.js";

class CrossContextContainer extends DiscordUiContainer {
  constructor(params: {
    originLabel: string;
    message: string;
    cfg: ConstructorParameters<typeof DiscordUiContainer>[0]["cfg"];
    accountId?: string | null;
  }) {
    const components: Array<TextDisplay | Separator> = [];
    if (params.message.trim()) {
      components.push(new TextDisplay(params.message));
      components.push(new Separator({ divider: true, spacing: "small" }));
    }
    components.push(new TextDisplay(`*From ${params.originLabel}*`));
    super({ cfg: params.cfg, accountId: params.accountId, components });
  }
}

export const discordChannelMessageAdapter: ChannelMessageAdapter = {
  supportsComponentsV2: true,
  buildCrossContextComponents: ({ originLabel, message, cfg, accountId }) => [
    new CrossContextContainer({ originLabel, message, cfg, accountId }),
  ],
};
