import { requirePluginRuntimeProvider } from "../plugins/runtime-provider-runtime.js";
import type { MediaRuntimeProvider } from "../plugins/runtime-provider-types.js";

export const loadWebMedia = (...args: Parameters<MediaRuntimeProvider["loadWebMedia"]>) =>
  requirePluginRuntimeProvider("media").loadWebMedia(...args);
export const loadWebMediaRaw = (...args: Parameters<MediaRuntimeProvider["loadWebMediaRaw"]>) =>
  requirePluginRuntimeProvider("media").loadWebMediaRaw(...args);
export const getDefaultLocalRoots = (
  ...args: Parameters<MediaRuntimeProvider["getDefaultLocalRoots"]>
) => requirePluginRuntimeProvider("media").getDefaultLocalRoots(...args);
export const optimizeImageToJpeg = (
  ...args: Parameters<MediaRuntimeProvider["optimizeImageToJpeg"]>
) => requirePluginRuntimeProvider("media").optimizeImageToJpeg(...args);
export const fetchRemoteMedia = (...args: Parameters<MediaRuntimeProvider["fetchRemoteMedia"]>) =>
  requirePluginRuntimeProvider("media").fetchRemoteMedia(...args);
export const saveMediaBuffer = (...args: Parameters<MediaRuntimeProvider["saveMediaBuffer"]>) =>
  requirePluginRuntimeProvider("media").saveMediaBuffer(...args);
export const getMediaDir = (...args: Parameters<MediaRuntimeProvider["getMediaDir"]>) =>
  requirePluginRuntimeProvider("media").getMediaDir(...args);
export const ensureMediaDir = (...args: Parameters<MediaRuntimeProvider["ensureMediaDir"]>) =>
  requirePluginRuntimeProvider("media").ensureMediaDir(...args);
export const detectMime = (...args: Parameters<MediaRuntimeProvider["detectMime"]>) =>
  requirePluginRuntimeProvider("media").detectMime(...args);
export const mediaKindFromMime = (...args: Parameters<MediaRuntimeProvider["mediaKindFromMime"]>) =>
  requirePluginRuntimeProvider("media").mediaKindFromMime(...args);
export const isVoiceCompatibleAudio = (
  ...args: Parameters<MediaRuntimeProvider["isVoiceCompatibleAudio"]>
) => requirePluginRuntimeProvider("media").isVoiceCompatibleAudio(...args);
export const getImageMetadata = (...args: Parameters<MediaRuntimeProvider["getImageMetadata"]>) =>
  requirePluginRuntimeProvider("media").getImageMetadata(...args);
export const resizeToJpeg = (...args: Parameters<MediaRuntimeProvider["resizeToJpeg"]>) =>
  requirePluginRuntimeProvider("media").resizeToJpeg(...args);

export type WebMediaResult = Awaited<ReturnType<MediaRuntimeProvider["loadWebMedia"]>>;
