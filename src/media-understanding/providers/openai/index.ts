import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";
import { transcribeOpenAiCompatibleAudio } from "./audio.js";

export const openaiProvider: MediaUnderstandingProvider = {
  id: "openai",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  transcribeAudio: transcribeOpenAiCompatibleAudio,
};

export const openaiCodexProvider: MediaUnderstandingProvider = {
  id: "openai-codex",
  capabilities: ["audio"],
  transcribeAudio: transcribeOpenAiCompatibleAudio,
};
