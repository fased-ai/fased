export type MediaRuntimeProvider = {
  loadWebMedia: typeof import("../web/media.js").loadWebMedia;
  loadWebMediaRaw: typeof import("../web/media.js").loadWebMediaRaw;
  getDefaultLocalRoots: typeof import("../web/media.js").getDefaultLocalRoots;
  optimizeImageToJpeg: typeof import("../web/media.js").optimizeImageToJpeg;
  fetchRemoteMedia: typeof import("../media/fetch.js").fetchRemoteMedia;
  saveMediaBuffer: typeof import("../media/store.js").saveMediaBuffer;
  getMediaDir: typeof import("../media/store.js").getMediaDir;
  ensureMediaDir: typeof import("../media/store.js").ensureMediaDir;
  detectMime: typeof import("../media/mime.js").detectMime;
  mediaKindFromMime: typeof import("../media/constants.js").mediaKindFromMime;
  isVoiceCompatibleAudio: typeof import("../media/audio.js").isVoiceCompatibleAudio;
  getImageMetadata: typeof import("../media/image-ops.js").getImageMetadata;
  resizeToJpeg: typeof import("../media/image-ops.js").resizeToJpeg;
};

export type SpeechRuntimeProvider = typeof import("../tts/tts.js");

export type PluginRuntimeProviderRegistration =
  | { kind: "media"; provider: MediaRuntimeProvider }
  | { kind: "speech"; provider: SpeechRuntimeProvider };

export type PluginRuntimeProviderRegistry = {
  media?: MediaRuntimeProvider;
  speech?: SpeechRuntimeProvider;
};
