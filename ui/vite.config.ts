import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = (
  JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf8")) as {
    version?: string;
  }
).version?.trim();

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

function fasedBootWatchdogPlugin(): Plugin {
  const watchdogTag =
    '    <script data-fased-boot-watchdog src="./boot-watchdog.js" defer></script>';
  return {
    name: "fased-boot-watchdog",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (html.includes("data-fased-boot-watchdog")) {
          return html;
        }
        if (html.includes('<script type="module"')) {
          return html.replace(/(\s*<script type="module"[^>]*><\/script>)/, `\n${watchdogTag}$1`);
        }
        return html.replace("</head>", `${watchdogTag}\n  </head>`);
      },
    },
  };
}

function fasedBuildVersionPlugin(version: string): Plugin {
  return {
    name: "fased-build-version",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ version })}\n`,
      });
    },
  };
}

export default defineConfig(() => {
  const envBase = process.env.FASED_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    define: {
      __FASED_UI_VERSION__: JSON.stringify(packageVersion || "dev"),
    },
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    plugins: [fasedBootWatchdogPlugin(), fasedBuildVersionPlugin(packageVersion || "dev")],
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
  };
});
