import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FasedAgentConfig } from "../../config/config.js";
import { generateImage } from "../../image-generation/runtime.js";
import { saveMediaBuffer } from "../../media/store.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunAccountingByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/task-executor.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { generateVideo } from "../../video-generation/runtime.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import {
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  VIDEO_GENERATION_TASK_KIND,
} from "../video-generation-task-status.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const IMAGE_GENERATION_TASK_KIND = "image_generation";
const IMAGE_GENERATION_SOURCE_PREFIX = "image_generate";
const VIDEO_GENERATION_SOURCE_PREFIX = "video_generate";
const GENERATED_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const GENERATED_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

const ImageGenerateSchema = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("generate"), Type.Literal("status")])),
  prompt: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  count: Type.Optional(Type.Number()),
  size: Type.Optional(Type.String()),
  aspectRatio: Type.Optional(Type.String()),
  resolution: Type.Optional(Type.String()),
});

const VideoGenerateSchema = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("generate"), Type.Literal("status")])),
  prompt: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  size: Type.Optional(Type.String()),
  aspectRatio: Type.Optional(Type.String()),
  resolution: Type.Optional(Type.String()),
  durationSeconds: Type.Optional(Type.Number()),
  audio: Type.Optional(Type.Boolean()),
  watermark: Type.Optional(Type.Boolean()),
});

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (value === "true" || value === "yes" || value === "1") {
      return true;
    }
    if (value === "false" || value === "no" || value === "0") {
      return false;
    }
  }
  return undefined;
}

function providerHintFromModelRef(model?: string): string {
  const ref = model?.trim();
  if (!ref) {
    return "auto";
  }
  const index = ref.indexOf("/");
  return index > 0 ? ref.slice(0, index) : "auto";
}

function mediaOutputMetadata(
  saved: Array<{ id: string; path: string; size: number; contentType?: string }>,
) {
  return {
    mediaCount: saved.length,
    mediaIds: saved.map((entry) => entry.id),
    mediaPaths: saved.map((entry) => entry.path),
    mediaContentTypes: saved.map((entry) => entry.contentType ?? "application/octet-stream"),
    mediaSizes: saved.map((entry) => entry.size),
  };
}

function mediaToolResult(params: {
  summary: string;
  payload: Record<string, unknown>;
  mediaPaths?: string[];
}) {
  const mediaLines = (params.mediaPaths ?? []).map((mediaPath) => `MEDIA:${mediaPath}`);
  return {
    content: [
      {
        type: "text" as const,
        text: [params.summary, ...mediaLines, JSON.stringify(params.payload, null, 2)].join("\n"),
      },
    ],
    details: params.payload,
  };
}

function taskStatusResult(task: TaskRecord | null, emptyLabel: string) {
  if (!task) {
    return jsonResult({
      status: "idle",
      active: false,
      message: emptyLabel,
    });
  }
  return jsonResult({
    status: "running",
    active: true,
    task: {
      taskId: task.taskId,
      runId: task.runId,
      status: task.status,
      progressSummary: task.progressSummary,
      sourceId: task.sourceId,
    },
  });
}

export function createImageGenerateTool(opts: {
  config?: FasedAgentConfig;
  agentDir?: string;
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "Image Generate",
    name: "image_generate",
    description: "Generate images with configured image-generation providers.",
    parameters: ImageGenerateSchema,
    execute: async (toolCallId, args) => {
      const params = asRecord(args);
      const action = readStringParam(params, "action") ?? "generate";
      if (action === "status") {
        return taskStatusResult(
          findActiveSessionTask({
            sessionKey: opts.agentSessionKey,
            runtime: "media",
            taskKind: IMAGE_GENERATION_TASK_KIND,
            sourceIdPrefix: IMAGE_GENERATION_SOURCE_PREFIX,
          }),
          "No active image generation task for this session.",
        );
      }
      const prompt = readStringParam(params, "prompt", { required: true });
      const modelOverride = readStringParam(params, "model");
      const count = readNumberParam(params, "count", { integer: true });
      const size = readStringParam(params, "size");
      const aspectRatio = readStringParam(params, "aspectRatio");
      const resolution = readStringParam(params, "resolution");
      const runId = randomUUID();
      const providerHint = providerHintFromModelRef(modelOverride);
      createRunningTaskRun({
        runtime: "media",
        sourceId: `${IMAGE_GENERATION_SOURCE_PREFIX}:${providerHint}`,
        ownerKey: opts.agentSessionKey,
        requesterSessionKey: opts.agentSessionKey,
        sessionKey: opts.agentSessionKey,
        agentId: opts.agentId,
        runId,
        taskKind: IMAGE_GENERATION_TASK_KIND,
        task: prompt,
        deliveryStatus: "not_applicable",
        model: modelOverride,
        scopeKind: opts.agentSessionKey ? "session" : "agent",
        metadata: {
          action: "generate",
          toolCallId,
          providerHint,
          requestedModel: modelOverride,
          promptLength: prompt.length,
          count,
          size,
          aspectRatio,
          resolution,
          artifactKind: "image",
        },
      });
      try {
        recordTaskRunProgressByRunId({
          runId,
          runtime: "media",
          sessionKey: opts.agentSessionKey,
          eventSummary: "Generating image",
        });
        const result = await generateImage({
          cfg: opts.config ?? {},
          agentDir: opts.agentDir,
          prompt,
          modelOverride,
          count,
          size,
          aspectRatio,
          resolution: resolution as never,
        });
        const saved = await Promise.all(
          result.images.map((image) =>
            saveMediaBuffer(
              image.buffer,
              image.mimeType,
              "generated",
              GENERATED_IMAGE_MAX_BYTES,
              image.fileName,
            ),
          ),
        );
        recordTaskRunAccountingByRunId({
          runId,
          provider: result.provider,
          model: result.model,
          metadata: {
            attempts: result.attempts,
            ignoredOverrides: result.ignoredOverrides,
            resultMetadata: result.metadata,
            ...mediaOutputMetadata(saved),
          },
        });
        completeTaskRunByRunId({
          runId,
          summary: `Generated ${saved.length} image(s) with ${result.provider}/${result.model}.`,
          deliveryStatus: "not_applicable",
        });
        return mediaToolResult({
          summary: `Generated ${saved.length} image(s).`,
          mediaPaths: saved.map((entry) => entry.path),
          payload: {
            status: "ok",
            taskId: `media:${runId}`,
            runId,
            provider: result.provider,
            model: result.model,
            images: saved.map((entry) => ({
              id: entry.id,
              path: entry.path,
              contentType: entry.contentType,
              size: entry.size,
            })),
            ignoredOverrides: result.ignoredOverrides,
            metadata: result.metadata,
          },
        });
      } catch (err) {
        failTaskRunByRunId({
          runId,
          status: "failed",
          summary: "Image generation failed.",
          error: String(err),
          deliveryStatus: "not_applicable",
        });
        throw err;
      }
    },
  };
}

export function createVideoGenerateTool(opts: {
  config?: FasedAgentConfig;
  agentDir?: string;
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "Video Generate",
    name: "video_generate",
    description: "Generate or check status for videos with configured video providers.",
    parameters: VideoGenerateSchema,
    execute: async (toolCallId, args) => {
      const params = asRecord(args);
      const action = readStringParam(params, "action") ?? "generate";
      if (action === "status") {
        const active = findActiveVideoGenerationTaskForSession(opts.agentSessionKey);
        if (!active) {
          return taskStatusResult(null, "No active video generation task for this session.");
        }
        return jsonResult({
          status: "running",
          active: true,
          text: buildVideoGenerationTaskStatusText(active),
          details: buildVideoGenerationTaskStatusDetails(active),
        });
      }
      const prompt = readStringParam(params, "prompt", { required: true });
      const modelOverride = readStringParam(params, "model");
      const size = readStringParam(params, "size");
      const aspectRatio = readStringParam(params, "aspectRatio");
      const resolution = readStringParam(params, "resolution");
      const durationSeconds = readNumberParam(params, "durationSeconds", { integer: true });
      const audio = readBooleanParam(params, "audio");
      const watermark = readBooleanParam(params, "watermark");
      const runId = randomUUID();
      const providerHint = providerHintFromModelRef(modelOverride);
      createRunningTaskRun({
        runtime: "media",
        sourceId: `${VIDEO_GENERATION_SOURCE_PREFIX}:${providerHint}`,
        ownerKey: opts.agentSessionKey,
        requesterSessionKey: opts.agentSessionKey,
        sessionKey: opts.agentSessionKey,
        agentId: opts.agentId,
        runId,
        taskKind: VIDEO_GENERATION_TASK_KIND,
        task: prompt,
        deliveryStatus: "not_applicable",
        model: modelOverride,
        scopeKind: opts.agentSessionKey ? "session" : "agent",
        metadata: {
          action: "generate",
          toolCallId,
          providerHint,
          requestedModel: modelOverride,
          promptLength: prompt.length,
          size,
          aspectRatio,
          resolution,
          durationSeconds,
          audio,
          watermark,
          artifactKind: "video",
        },
      });
      try {
        recordTaskRunProgressByRunId({
          runId,
          runtime: "media",
          sessionKey: opts.agentSessionKey,
          eventSummary: "Generating video",
        });
        const result = await generateVideo({
          cfg: opts.config ?? {},
          agentDir: opts.agentDir,
          prompt,
          modelOverride,
          size,
          aspectRatio,
          resolution: resolution as never,
          durationSeconds,
          audio,
          watermark,
        });
        const saved = await Promise.all(
          result.videos.map((video) =>
            saveMediaBuffer(
              video.buffer,
              video.mimeType,
              "generated",
              GENERATED_VIDEO_MAX_BYTES,
              video.fileName,
            ),
          ),
        );
        recordTaskRunAccountingByRunId({
          runId,
          provider: result.provider,
          model: result.model,
          metadata: {
            attempts: result.attempts,
            ignoredOverrides: result.ignoredOverrides,
            resultMetadata: result.metadata,
            ...mediaOutputMetadata(saved),
          },
        });
        completeTaskRunByRunId({
          runId,
          summary: `Generated ${saved.length} video(s) with ${result.provider}/${result.model}.`,
          deliveryStatus: "not_applicable",
        });
        return mediaToolResult({
          summary: `Generated ${saved.length} video(s).`,
          mediaPaths: saved.map((entry) => entry.path),
          payload: {
            status: "ok",
            taskId: `media:${runId}`,
            runId,
            provider: result.provider,
            model: result.model,
            videos: saved.map((entry) => ({
              id: entry.id,
              path: entry.path,
              contentType: entry.contentType,
              size: entry.size,
            })),
            ignoredOverrides: result.ignoredOverrides,
            metadata: result.metadata,
          },
        });
      } catch (err) {
        failTaskRunByRunId({
          runId,
          status: "failed",
          summary: "Video generation failed.",
          error: String(err),
          deliveryStatus: "not_applicable",
        });
        throw err;
      }
    },
  };
}
