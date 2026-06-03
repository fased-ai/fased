import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tasksHandlers } from "../../gateway/server-methods/tasks.js";
import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import { listTaskRecords, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import type { TaskListResult } from "../../tasks/task-registry.types.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import { createImageGenerateTool, createVideoGenerateTool } from "./media-generation-tools.js";

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  saveMediaBuffer: vi.fn(),
}));

async function listTasksViaGateway(params: Record<string, unknown>): Promise<TaskListResult> {
  const respond = vi.fn();
  await tasksHandlers["tasks.list"]({
    method: "tasks.list",
    params,
    respond,
    context: {
      cronStorePath: path.join(process.env.FASED_STATE_DIR ?? os.tmpdir(), "cron-runs.json"),
      cron: {},
    },
  } as unknown as GatewayRequestHandlerOptions);
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  return respond.mock.calls[0]?.[1] as TaskListResult;
}

vi.mock("../../image-generation/runtime.js", () => ({
  generateImage: mocks.generateImage,
}));

vi.mock("../../video-generation/runtime.js", () => ({
  generateVideo: mocks.generateVideo,
}));

vi.mock("../../media/store.js", () => ({
  saveMediaBuffer: mocks.saveMediaBuffer,
}));

describe("media generation tools", () => {
  beforeEach(async () => {
    vi.stubEnv("FASED_STATE_DIR", await fs.mkdtemp(path.join(os.tmpdir(), "fased-media-tool-")));
    resetTaskRegistryForTests({ persist: false });
    mocks.generateImage.mockReset();
    mocks.generateVideo.mockReset();
    mocks.saveMediaBuffer.mockReset();
  });

  it("records image generation in the task ledger", async () => {
    mocks.generateImage.mockResolvedValue({
      images: [{ buffer: Buffer.from("png"), mimeType: "image/png", fileName: "demo.png" }],
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      ignoredOverrides: [],
      metadata: { revised: false },
    });
    mocks.saveMediaBuffer.mockResolvedValue({
      id: "demo.png",
      path: "/tmp/fased/generated/demo.png",
      size: 3,
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {},
      agentSessionKey: "agent:main:webchat:direct:1",
      agentId: "main",
    });
    const result = await tool.execute?.("tool-call-1", {
      prompt: "draw a test diagram",
      model: "openai/gpt-image-1",
    });

    expect(result?.details).toMatchObject({
      status: "ok",
      provider: "openai",
      model: "gpt-image-1",
    });
    const firstContent = result?.content?.[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent && "text" in firstContent ? String(firstContent.text) : "").toContain(
      "MEDIA:/tmp/fased/generated/demo.png",
    );
    const task = listTaskRecords({ source: "media" }).tasks[0];
    expect(task).toMatchObject({
      source: "media",
      runtime: "media",
      taskKind: "image_generation",
      status: "succeeded",
      provider: "openai",
      model: "gpt-image-1",
      sessionKey: "agent:main:webchat:direct:1",
      deliveryStatus: "not_applicable",
      metadata: {
        toolCallId: "tool-call-1",
        providerHint: "openai",
        requestedModel: "openai/gpt-image-1",
        promptLength: "draw a test diagram".length,
        artifactKind: "image",
        mediaCount: 1,
        mediaIds: ["demo.png"],
        mediaPaths: ["/tmp/fased/generated/demo.png"],
        mediaContentTypes: ["image/png"],
        mediaSizes: [3],
        resultMetadata: { revised: false },
      },
    });
    const ledger = await listTasksViaGateway({
      source: "media",
      agentId: "main",
      sessionKey: "agent:main:webchat:direct:1",
      limit: 10,
    });
    expect(ledger).toMatchObject({
      total: 1,
      summary: { bySource: { media: 1 } },
      tasks: [
        expect.objectContaining({
          source: "media",
          taskKind: "image_generation",
          agentId: "main",
          metadata: expect.objectContaining({
            artifactKind: "image",
            mediaIds: ["demo.png"],
            mediaSizes: [3],
          }),
        }),
      ],
    });
  });

  it("records video generation outputs in the task ledger", async () => {
    mocks.generateVideo.mockResolvedValue({
      videos: [{ buffer: Buffer.from("mp4"), mimeType: "video/mp4", fileName: "demo.mp4" }],
      provider: "runway",
      model: "gen4",
      attempts: [{ provider: "runway", model: "gen4", status: "ok" }],
      ignoredOverrides: [],
      metadata: { providerJobId: "job-1" },
    });
    mocks.saveMediaBuffer.mockResolvedValue({
      id: "demo.mp4",
      path: "/tmp/fased/generated/demo.mp4",
      size: 3,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: {},
      agentSessionKey: "agent:main:webchat:direct:1",
      agentId: "main",
    });
    const result = await tool.execute?.("tool-call-video", {
      prompt: "make a short test clip",
      model: "runway/gen4",
      durationSeconds: 4,
      audio: true,
    });

    expect(result?.details).toMatchObject({
      status: "ok",
      provider: "runway",
      model: "gen4",
    });
    const task = listTaskRecords({ source: "media" }).tasks[0];
    expect(task).toMatchObject({
      source: "media",
      runtime: "media",
      taskKind: VIDEO_GENERATION_TASK_KIND,
      status: "succeeded",
      provider: "runway",
      model: "gen4",
      sessionKey: "agent:main:webchat:direct:1",
      deliveryStatus: "not_applicable",
      metadata: {
        toolCallId: "tool-call-video",
        providerHint: "runway",
        requestedModel: "runway/gen4",
        promptLength: "make a short test clip".length,
        artifactKind: "video",
        durationSeconds: 4,
        audio: true,
        mediaCount: 1,
        mediaIds: ["demo.mp4"],
        mediaPaths: ["/tmp/fased/generated/demo.mp4"],
        mediaContentTypes: ["video/mp4"],
        mediaSizes: [3],
        resultMetadata: { providerJobId: "job-1" },
      },
    });
    const ledger = await listTasksViaGateway({
      source: "media",
      agentId: "main",
      sessionKey: "agent:main:webchat:direct:1",
      limit: 10,
    });
    expect(ledger.summary.bySource.media).toBe(1);
    expect(ledger.tasks[0]).toMatchObject({
      source: "media",
      taskKind: VIDEO_GENERATION_TASK_KIND,
      metadata: expect.objectContaining({
        artifactKind: "video",
        mediaIds: ["demo.mp4"],
        mediaSizes: [3],
      }),
    });
  });

  it("reports active video generation status from media task records", async () => {
    resetTaskRegistryForTests({
      persist: false,
      tasks: [
        {
          taskId: "media:run-video",
          runId: "run-video",
          source: "media",
          runtime: "media",
          taskKind: VIDEO_GENERATION_TASK_KIND,
          sourceId: "video_generate:qwen",
          requesterSessionKey: "agent:main:webchat:direct:1",
          ownerKey: "agent:main:webchat:direct:1",
          sessionKey: "agent:main:webchat:direct:1",
          scopeKind: "session",
          task: "make a video",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          progressSummary: "Generating video",
          createdAt: Date.now(),
        },
      ],
    });

    const tool = createVideoGenerateTool({
      config: {},
      agentSessionKey: "agent:main:webchat:direct:1",
      agentId: "main",
    });
    const result = await tool.execute?.("tool-call-1", { action: "status" });

    expect(result?.details).toMatchObject({
      status: "running",
      active: true,
      details: {
        active: true,
        provider: "qwen",
        progressSummary: "Generating video",
      },
    });
  });
});
