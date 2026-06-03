import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterEach, beforeEach, describe, it } from "vitest";
import { startGatewayServer } from "../src/gateway/server.js";
import { getFreeGatewayPort } from "../src/gateway/test-helpers.e2e.js";
import { resetTaskRegistryForTests } from "../src/tasks/task-registry.js";

const ENV_KEYS = [
  "HOME",
  "FASED_CONFIG_PATH",
  "FASED_STATE_DIR",
  "FASED_GATEWAY_TOKEN",
  "FASED_SKIP_CHANNELS",
  "FASED_SKIP_GMAIL_WATCHER",
  "FASED_SKIP_CANVAS_HOST",
  "FASED_SKIP_BROWSER_CONTROL_SERVER",
  "FASED_TEST_MINIMAL_GATEWAY",
  "FASED_DISABLE_CONFIG_CACHE",
  "FASED_FEDERATION_AUTO_CONNECT",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;

type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;

type SmokeTask = {
  taskId: string;
  source?: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

type SmokeWorkflowDefinition = {
  id: string;
  name: string;
  task: string;
  notifyPolicy?: string;
  graph: unknown;
};

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as EnvSnapshot;
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function resolvePlaywrightBrowsersPath(): Promise<string> {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    process.env.USER ? path.join("/home", process.env.USER, ".cache", "ms-playwright") : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next common cache location.
    }
  }
  return candidates[0] ?? path.join(os.homedir(), ".cache", "ms-playwright");
}

async function waitForApp(page: Page) {
  await page.waitForSelector("fased-app", { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("fased-app");
      return Boolean(app?.connected);
    },
    null,
    { timeout: 60_000 },
  );
}

async function waitForAppText(page: Page, text: string) {
  await page.waitForFunction(
    (needle) => document.querySelector("fased-app")?.textContent?.includes(String(needle)),
    text,
    { timeout: 20_000 },
  );
}

describe("Control UI task workflow smoke", () => {
  let env: EnvSnapshot;
  let browser: Browser | null = null;

  beforeEach(() => {
    env = snapshotEnv();
    resetTaskRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    await browser?.close();
    browser = null;
    resetTaskRegistryForTests({ persist: false });
    restoreEnv(env);
  });

  it(
    "runs webhook trigger to ledger task to workflow review and approval resume in the served UI",
    { timeout: 180_000 },
    async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "fased-ui-taskflow-smoke-"));
      const playwrightBrowsersPath = await resolvePlaywrightBrowsersPath();
      const workspace = path.join(home, "workspace");
      const stateDir = path.join(home, ".fased");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(stateDir, { recursive: true });

      const token = `smoke-${randomUUID()}`;
      const configPath = path.join(stateDir, "fased.json");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: {
              defaults: { workspace },
              list: [{ id: "main", name: "Assistant", workspace, default: true }],
            },
            gateway: {
              auth: { mode: "token", token },
              controlUi: { enabled: true },
            },
            hooks: {
              enabled: true,
              path: "/hooks",
              token: "hook_smoke",
              mappings: [],
            },
            models: { mode: "replace", providers: {} },
          },
          null,
          2,
        )}\n`,
      );

      process.env.HOME = home;
      process.env.FASED_STATE_DIR = stateDir;
      process.env.FASED_CONFIG_PATH = configPath;
      process.env.FASED_GATEWAY_TOKEN = token;
      process.env.FASED_SKIP_CHANNELS = "1";
      process.env.FASED_SKIP_GMAIL_WATCHER = "1";
      process.env.FASED_SKIP_CANVAS_HOST = "1";
      process.env.FASED_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.FASED_TEST_MINIMAL_GATEWAY = "1";
      process.env.FASED_DISABLE_CONFIG_CACHE = "1";
      process.env.FASED_FEDERATION_AUTO_CONNECT = "0";
      process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;

      const port = await getFreeGatewayPort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: true,
      });

      try {
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/agents?token=${encodeURIComponent(token)}`, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        await waitForApp(page);

        const created = await page.evaluate(async () => {
          const app = document.querySelector("fased-app");
          if (!app) {
            throw new Error("fased-app was not mounted");
          }
          app.tab = "agents";
          app.agentsPanel = "cron";
          app.agentsSelectedId = "main";
          app.requestUpdate?.();
          await app.updateComplete;
          await app.loadWebhookTriggers();
          await app.loadCron();

          const path = `smoke-${Date.now()}`;
          app.startWebhookTriggerCreate("main");
          app.patchWebhookTriggerDraft({
            name: "Browser smoke webhook",
            path,
            action: "agent",
            agentId: "main",
            messageTemplate: "Browser smoke payload {{payload.message}}",
            notifyPolicy: "state_changes",
          });
          await app.saveWebhookTriggerDraft();
          const trigger = app.webhookTriggers?.triggers?.find((entry) => entry.path === path);
          if (!trigger) {
            throw new Error("created trigger was not returned to the UI");
          }

          await app.client.request("webhookTriggers.test", {
            id: trigger.id,
            payload: {
              test: true,
              trigger: trigger.id,
              message: "Control UI webhook trigger test",
            },
          });
          await app.loadCron();
          const sourceTask = app.taskLedger?.tasks?.find(
            (entry) => entry.source === "webhook" && entry.metadata?.triggerId === trigger.id,
          );
          if (!sourceTask) {
            throw new Error(
              `webhook trigger test did not create a ledger source task: ${JSON.stringify({
                triggerId: trigger.id,
                error: app.webhookTriggersError,
                message: app.webhookTriggersMessage,
                tasks: app.taskLedger?.tasks,
              })}`,
            );
          }

          const graph = {
            version: 2,
            startNodeId: "start",
            nodes: [
              { id: "start", type: "start", label: "Start review" },
              {
                id: "approval",
                type: "approval",
                label: "Approve webhook handoff",
                input: "Approve the webhook handoff before continuing.",
              },
              { id: "done", type: "end", label: "Done" },
            ],
            edges: [
              { id: "start-success-approval", from: "start", to: "approval", on: "success" },
              { id: "approval-approved-done", from: "approval", to: "done", on: "approved" },
              { id: "approval-rejected-done", from: "approval", to: "done", on: "rejected" },
            ],
          };
          const saved = await app.client.request<{ definition: SmokeWorkflowDefinition }>(
            "tasks.workflow.definitions.save",
            {
              id: "browser-smoke-webhook-review",
              agentId: "main",
              name: "Browser smoke webhook review",
              task: "Review the webhook source task before handoff.",
              notifyPolicy: "state_changes",
              graph,
            },
          );
          const run = await app.client.request<{ task: SmokeTask }>("tasks.workflow.graph.run", {
            definitionId: saved.definition.id,
            agentId: "main",
            name: saved.definition.name,
            task: saved.definition.task,
            notifyPolicy: saved.definition.notifyPolicy,
            graph: saved.definition.graph,
            sourceTask,
          });
          await app.loadCron();
          await app.updateComplete;
          return {
            sourceTaskId: sourceTask.taskId,
            workflowTaskId: run.task.taskId,
            triggerId: trigger.id,
          };
        });

        await page.locator('button.agent-tab:has-text("Tasks"):visible').first().click();
        await waitForAppText(page, "Browser smoke webhook");
        await waitForAppText(page, "Browser smoke webhook review");
        await waitForAppText(page, "needs review");
        await waitForAppText(page, "Open source task");

        await page
          .locator("details.agent-task-row:visible", { hasText: "Browser smoke webhook review" })
          .first()
          .locator(":scope > summary")
          .click();
        const workflowGraphButton = page
          .locator('button[aria-label="Open workflow graph"]')
          .first();
        await workflowGraphButton.scrollIntoViewIfNeeded();
        await workflowGraphButton.click();
        await page.waitForSelector('[data-workflow-graph-builder="true"]', { timeout: 20_000 });
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-workflow-run-timeline="true"]')
              ?.textContent?.includes("Approve webhook handoff"),
          null,
          { timeout: 20_000 },
        );
        await page.getByRole("button", { name: "Close workflow editor" }).click();

        await page.getByRole("button", { name: "Open source task" }).first().click();
        await page.waitForFunction(
          ({ triggerId }) => {
            const app = document.querySelector("fased-app");
            return (
              app?.taskLedgerSourceFilter === "webhook" &&
              window.location.hash === `#webhook-trigger-${triggerId}`
            );
          },
          created,
          { timeout: 20_000 },
        );
        await waitForAppText(page, "Browser smoke webhook");

        await page.evaluate(async () => {
          const app = document.querySelector("fased-app");
          if (!app) {
            throw new Error("fased-app was not mounted");
          }
          app.setTaskLedgerSourceFilter("all");
          await app.updateComplete;
        });
        await page.getByRole("button", { name: "Approve/resume workflow" }).first().click();
        await page.waitForFunction(
          ({ workflowTaskId }) => {
            const app = document.querySelector("fased-app");
            const task = app?.taskLedger?.tasks?.find((entry) => entry.taskId === workflowTaskId);
            return task?.status === "succeeded";
          },
          created,
          { timeout: 20_000 },
        );
        await waitForAppText(page, "succeeded");
      } finally {
        await server.close();
      }
    },
  );
});
