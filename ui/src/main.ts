import "./styles.css";
import { markControlUiBootStage } from "./ui/boot-state.ts";

function renderBootFailure(error: unknown) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  markControlUiBootStage("boot-failed", message || "Unknown dashboard boot error.");
  const host = document.querySelector("fased-app");
  if (!host) {
    return;
  }
  host.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = `
    body {
      margin: 0;
      background: #080e1a;
      color: #e2e8f0;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .boot-page {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .boot-card {
      width: 100%;
      max-width: 560px;
      background: #0f1929;
      border: 1px solid rgba(248, 113, 113, 0.28);
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    }
    .boot-title {
      margin: 0 0 8px;
      font-size: 22px;
      font-weight: 700;
      color: #f0f4ff;
    }
    .boot-desc {
      margin: 0 0 18px;
      color: #9aa5bf;
      line-height: 1.6;
    }
    .boot-error {
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: #060d1a;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 12px;
      color: #fca5a5;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .boot-button {
      margin-top: 20px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      background: #1d4ed8;
      color: white;
      padding: 10px 14px;
      font-weight: 650;
      cursor: pointer;
    }
  `;
  const page = document.createElement("div");
  page.className = "boot-page";
  const card = document.createElement("section");
  card.className = "boot-card";
  const title = document.createElement("h1");
  title.className = "boot-title";
  title.textContent = "Dashboard bundle could not load";
  const desc = document.createElement("p");
  desc.className = "boot-desc";
  desc.textContent =
    "The gateway page loaded, but the browser could not start the dashboard bundle. Reload first. If it keeps happening after an update, clear this site's browser data and sign in again.";
  const detail = document.createElement("div");
  detail.className = "boot-error";
  detail.textContent = message || "Unknown dashboard boot error.";
  const button = document.createElement("button");
  button.className = "boot-button";
  button.textContent = "Reload";
  button.addEventListener("click", () => window.location.reload());
  card.append(title, desc, detail, button);
  page.append(card);
  host.append(style, page);
}

markControlUiBootStage("entry-loaded");
markControlUiBootStage("app-import-start");
void import("./ui/app.ts")
  .then(() => markControlUiBootStage("app-imported"))
  .catch(renderBootFailure);
