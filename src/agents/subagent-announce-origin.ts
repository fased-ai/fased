import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

export function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
  const normalizedEntry = deliveryContextFromSession(entry);
  if (normalizedRequester?.channel && isInternalMessageChannel(normalizedRequester.channel)) {
    return mergeDeliveryContext(
      {
        accountId: normalizedRequester.accountId,
        threadId: normalizedRequester.threadId,
      },
      normalizedEntry,
    );
  }
  const entryForMerge =
    normalizedRequester?.to &&
    normalizedRequester.threadId == null &&
    normalizedEntry?.threadId != null
      ? (() => {
          const { threadId: _ignore, ...rest } = normalizedEntry;
          return rest;
        })()
      : normalizedEntry;
  return mergeDeliveryContext(normalizedRequester, entryForMerge);
}
