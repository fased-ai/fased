import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { isVoiceCompatibleAudio } from "../../src/media/audio.js";
import { mediaKindFromMime } from "../../src/media/constants.js";
import { fetchRemoteMedia } from "../../src/media/fetch.js";
import { getImageMetadata, resizeToJpeg } from "../../src/media/image-ops.js";
import { detectMime } from "../../src/media/mime.js";
import { ensureMediaDir, getMediaDir, saveMediaBuffer } from "../../src/media/store.js";
import {
  getDefaultLocalRoots,
  loadWebMedia,
  loadWebMediaRaw,
  optimizeImageToJpeg,
} from "../../src/web/media.js";

export default {
  id: "media-runtime",
  name: "Media Runtime",
  description: "Optional image, file-type, and PDF processing dependencies.",
  register(api: FasedAgentPluginApi) {
    api.registerRuntimeProvider({
      kind: "media",
      provider: {
        loadWebMedia,
        loadWebMediaRaw,
        getDefaultLocalRoots,
        optimizeImageToJpeg,
        fetchRemoteMedia,
        saveMediaBuffer,
        getMediaDir,
        ensureMediaDir,
        detectMime,
        mediaKindFromMime,
        isVoiceCompatibleAudio,
        getImageMetadata,
        resizeToJpeg,
      },
    });
  },
};
