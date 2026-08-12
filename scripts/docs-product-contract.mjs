import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(root, "docs");
const exactHostingCommand = [
  "curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \\",
  "| bash -s -- --hosting",
].join("\n");
const exactHostingPrereleaseCommand = [
  "curl -fsSL https://github.com/fased-ai/fased/releases/download/vX.Y.Z-rc.N/install.sh \\",
  "| bash -s -- --hosting --release vX.Y.Z-rc.N --update-channel beta",
].join("\n");
const expectedHostingPages = new Set([
  "README.md",
  "docs/install/index.md",
  "docs/install/vps.md",
  "docs/maintainers/codex-skills/fased-release-manager/references/lifecycle.md",
  "docs/start/agent-wallet-mining-walkthrough.md",
  "docs/start/fased.md",
  "docs/start/getting-started.md",
  "docs/zh-CN/install/index.md",
  "docs/zh-CN/install/vps.md",
  "docs/zh-CN/start/getting-started.md",
]);
const compactWalletDocsRoots = ["docs/start/", "docs/plugins/crypto/"];
const retiredWalletPhrases = [
  "Enter a name and wallet ID",
  "Enter a name and permanent wallet ID",
  "Primary Solana RPC",
  "Verify and save RPC",
  "wallet Security",
];

function fail(message) {
  throw new Error(`docs product contract: ${message}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function allMarkdownFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && /\.(?:md|mdx)$/u.test(entry.name)) {
        files.push(absolute);
      }
    }
  }
  return files.toSorted();
}

function normalizeCodeBlock(block) {
  return block
    .split("\n")
    .slice(1, -1)
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function tabBody(source, title) {
  const match = source.match(new RegExp(`<Tab title="${title}">([\\s\\S]*?)</Tab>`, "u"));
  if (!match) {
    fail(`missing ${title} tab`);
  }
  return match[1];
}

const markdownFiles = [path.join(root, "README.md"), ...allMarkdownFiles(docsRoot)];
const hostingPages = new Set();
const exactTagPages = new Set();

for (const absolute of markdownFiles) {
  const relative = path.relative(root, absolute);
  const source = fs.readFileSync(absolute, "utf8");
  const codeBlocks =
    source.match(/^[ \t]*```(?:bash|sh)[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gmu) ?? [];
  for (const block of codeBlocks) {
    if (
      (block.includes("https://github.com/fased-ai/fased/releases/latest/download/install.sh") ||
        block.includes(
          "https://github.com/fased-ai/fased/releases/download/vX.Y.Z-rc.N/install.sh",
        )) &&
      /--hosting\b/u.test(block)
    ) {
      hostingPages.add(relative);
      const command = normalizeCodeBlock(block);
      const isNormalCommand = command === exactHostingCommand;
      const isVpsPrereleaseCommand =
        relative === "docs/install/vps.md" && command === exactHostingPrereleaseCommand;
      if (!isNormalCommand && !isVpsPrereleaseCommand) {
        fail(`${relative} changes or adds arguments to the exact Hosting command`);
      }
    }
  }
  if (source.includes('GH_PROMPT_DISABLED=1 gh attestation verify "$BOOTSTRAP_DIR/install.sh"')) {
    exactTagPages.add(relative);
  }
  if (/tailscale\.com\/install\.sh[^\n]*\|/iu.test(source)) {
    fail(`${relative} documents the Tailscale remote installer pipe`);
  }
  if (
    source.includes("/install/vps#3-verify-and-run-the-hosting-bootstrap") ||
    source.includes("/install/vps#advanced-exact-release-selection") ||
    source.includes("/install/vps#advanced-verify-the-bootstrap-first")
  ) {
    fail(`${relative} links to a retired Hosting documentation anchor`);
  }
  if (/\bPrimary Agent\b/u.test(source) || /\bprimary Agent\b/u.test(source)) {
    fail(`${relative} uses the retired Primary Agent name`);
  }
  if (/\bnew wallets?\b[^.\n]{0,100}\b(?:deny-all|receive-only)\b/iu.test(source)) {
    fail(`${relative} claims that new wallets use the retired deny-all/receive-only lifecycle`);
  }
  if (source.includes("fased-signer-wallet-import")) {
    fail(`${relative} documents the retired Hosting root import helper`);
  }
  if (compactWalletDocsRoots.some((rootPrefix) => relative.startsWith(rootPrefix))) {
    for (const phrase of retiredWalletPhrases) {
      if (source.includes(phrase)) {
        fail(`${relative} uses retired Wallet setup wording: ${phrase}`);
      }
    }
    if (source.includes("fased wallet policy activate-role-baseline")) {
      fail(`${relative} documents manual baseline activation as a user workflow`);
    }
  }
}

if (
  hostingPages.size !== expectedHostingPages.size ||
  [...hostingPages].some((page) => !expectedHostingPages.has(page)) ||
  [...expectedHostingPages].some((page) => !hostingPages.has(page))
) {
  fail(
    `exact Hosting command pages differ: expected ${[...expectedHostingPages].join(", ")}; got ${[...hostingPages].join(", ")}`,
  );
}

const expectedExactTagPages = new Set([
  "docs/install/installer.md",
  "docs/zh-CN/install/installer.md",
]);
if (
  exactTagPages.size !== expectedExactTagPages.size ||
  [...exactTagPages].some((page) => !expectedExactTagPages.has(page))
) {
  fail(`exact-tag block must live only in the English and Chinese Advanced installer pages`);
}

for (const relative of ["docs/install/index.md", "docs/zh-CN/install/index.md"]) {
  const source = read(relative);
  const local = tabBody(source, "Local");
  const hosting = tabBody(source, "VPS Hosting");
  if (/--hosting\b/u.test(local) || /--local\b/u.test(hosting)) {
    fail(`${relative} mixes Local and Hosting tab commands`);
  }
}

for (const relative of ["docs/install/vps.md", "docs/zh-CN/install/vps.md"]) {
  const source = read(relative);
  const command = source.indexOf("github.com/fased-ai/fased/releases/");
  const advanced = source.indexOf("<AccordionGroup>");
  if (command < 0 || advanced < 0 || command > advanced) {
    fail(`${relative} must show the exact normal command before Advanced content`);
  }
  const visible = source.slice(0, advanced);
  if ((visible.match(/^### /gmu) ?? []).length !== 3) {
    fail(`${relative} normal install path must contain exactly three visible steps`);
  }
}

const docsNavigation = JSON.parse(read("docs/docs.json"));
const navigationText = JSON.stringify(docsNavigation.navigation);
for (const page of [
  "install/index",
  "install/vps",
  "install/installer",
  "plugins/crypto/wallet-roles-and-policies",
  "plugins/crypto/mining-page",
  "plugins/crypto/mining-troubleshooting",
]) {
  if (!navigationText.includes(`"${page}"`)) {
    fail(`docs navigation omits ${page}`);
  }
}

for (const translation of [
  "docs/zh-CN/cli/wallet.md",
  "docs/zh-CN/plugins/crypto/wallet-roles-and-policies.md",
  "docs/zh-CN/plugins/crypto/mining-page.md",
]) {
  if (!fs.existsSync(path.join(root, translation))) {
    fail(`missing Chinese product-contract page ${translation}`);
  }
}

console.log("docs product contract passed");
