(function () {
  var BOOT_TIMEOUT_MS = 15000;
  var BOOT_STAGE_RANK = {
    "watchdog-loaded": 5,
    "entry-loaded": 10,
    "app-import-start": 20,
    "app-imported": 30,
    "custom-element-defined": 40,
    connected: 50,
    "first-updated": 60,
    rendered: 70,
    "boot-failed": 100,
  };

  function now() {
    return Date.now();
  }

  var state = (window.__FASED_CONTROL_UI_BOOT = window.__FASED_CONTROL_UI_BOOT || {});
  state.stage = state.stage || "watchdog-loaded";
  state.updatedAt = state.updatedAt || now();
  var previousMark = typeof state.mark === "function" ? state.mark : null;
  var completed = bootRank(state.stage) >= BOOT_STAGE_RANK.connected;

  function mark(stage, detail) {
    if (previousMark && previousMark !== mark) {
      previousMark(stage, detail);
    }
    state.stage = stage;
    state.detail = detail || "";
    state.updatedAt = now();
    if (bootRank(stage) >= BOOT_STAGE_RANK.connected) {
      completed = true;
    }
  }

  state.mark = mark;

  window.addEventListener("fased-control-ui-boot", function (event) {
    var detail = event && event.detail ? event.detail : {};
    if (detail.stage) {
      mark(String(detail.stage), detail.detail ? String(detail.detail) : "");
    }
  });

  function bootRank(stage) {
    return BOOT_STAGE_RANK[stage || ""] || 0;
  }

  function hasStaticBootShell(host) {
    return Boolean(host.querySelector("[data-fased-boot-shell]"));
  }

  function renderFailure() {
    if (completed || bootRank(state.stage) >= BOOT_STAGE_RANK.connected) {
      return;
    }
    var host = document.querySelector("fased-app");
    if (!host || !hasStaticBootShell(host)) {
      return;
    }
    host.innerHTML = [
      "<style>",
      "body{margin:0;background:#080e1a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif}",
      ".boot-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}",
      ".boot-card{width:100%;max-width:560px;background:#0f1929;border:1px solid rgba(248,113,113,.28);border-radius:16px;padding:32px;box-shadow:0 24px 64px rgba(0,0,0,.5)}",
      ".boot-title{margin:0 0 8px;font-size:22px;font-weight:700;color:#f0f4ff}",
      ".boot-desc{margin:0 0 18px;color:#9aa5bf;line-height:1.6}",
      ".boot-error{white-space:pre-wrap;word-break:break-word;background:#060d1a;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;color:#fca5a5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
      ".boot-button{margin-top:20px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:#1d4ed8;color:white;padding:10px 14px;font-weight:650;cursor:pointer}",
      "</style>",
      '<div class="boot-page">',
      '<section class="boot-card">',
      '<h1 class="boot-title">Dashboard did not finish opening</h1>',
      '<p class="boot-desc">The page loaded, but the dashboard app did not mount. Reload first. If it keeps happening after an update, reset this site&rsquo;s browser data and sign in again.</p>',
      '<div class="boot-error">Last boot stage: ' +
        escapeText(state.stage || "unknown") +
        (state.detail ? "\\nDetail: " + escapeText(state.detail) : "") +
        "</div>",
      '<button class="boot-button" type="button" data-fased-boot-reload>Reload</button>',
      "</section>",
      "</div>",
    ].join("");
    var reload = host.querySelector("[data-fased-boot-reload]");
    if (reload) {
      reload.addEventListener("click", function () {
        window.location.reload();
      });
    }
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch];
    });
  }

  window.setTimeout(renderFailure, BOOT_TIMEOUT_MS);
})();
