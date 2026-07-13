export const FASED_BRAND_NAME = "Fased";
export const FASED_AGENT_NAME = "Fased Agent";
export const FASED_CONTROL_NAME = "Fased Control";
export const FASED_PRODUCT_VERSION = "0.1.58";
export const FASED_DISPLAY_VERSION = `v${FASED_PRODUCT_VERSION}`;

export function formatFasedDisplayLine(): string {
  return `${FASED_AGENT_NAME} ${FASED_DISPLAY_VERSION}`;
}
