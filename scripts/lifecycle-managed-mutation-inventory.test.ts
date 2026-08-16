import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(repoRoot, "config", "lifecycle-managed-mutation-inventory.v1.json");

type MutationEntry = {
  id: string;
  path: string;
  language: "shell" | "swift" | "typescript";
  mutationClasses: string[];
  evidenceTokens: string[];
  boundary: "managed-bootstrap" | "mixed-application" | "developer-source" | "deferred-platform";
  disposition: string;
  releaseBlocking: boolean;
  status: "implemented" | "partial" | "separate" | "deferred";
};

type MutationInventory = {
  schemaVersion: number;
  role: string;
  releaseRule: string;
  entries: MutationEntry[];
};

function loadInventory(): MutationInventory {
  return JSON.parse(readFileSync(inventoryPath, "utf8")) as MutationInventory;
}

describe("managed application mutation inventory", () => {
  it("binds every inventoried mutation owner to live source evidence", () => {
    const inventory = loadInventory();
    expect(inventory).toMatchObject({
      schemaVersion: 1,
      role: "fased-managed-application-mutation-inventory",
      releaseRule: "every-reachable-managed-mutation-must-have-one-explicit-owner",
    });

    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const entry of inventory.entries) {
      expect(ids.has(entry.id), `duplicate id ${entry.id}`).toBe(false);
      expect(paths.has(entry.path), `duplicate path ${entry.path}`).toBe(false);
      ids.add(entry.id);
      paths.add(entry.path);
      expect(entry.mutationClasses.length).toBeGreaterThan(0);
      expect(new Set(entry.mutationClasses).size).toBe(entry.mutationClasses.length);
      expect(entry.evidenceTokens.length).toBeGreaterThan(0);
      const source = readFileSync(path.join(repoRoot, entry.path), "utf8");
      for (const token of entry.evidenceTokens) {
        expect(source, `${entry.path} no longer contains ${token}`).toContain(token);
      }
      if (entry.releaseBlocking) {
        expect(entry.status).toBe("partial");
        expect(["managed-bootstrap", "mixed-application"]).toContain(entry.boundary);
      } else {
        expect(["implemented", "separate", "deferred"]).toContain(entry.status);
      }
    }
  });

  it("closes managed mutation residue while preserving separate source and signer-owner boundaries", () => {
    const blockers = loadInventory()
      .entries.filter((entry) => entry.releaseBlocking)
      .map((entry) => entry.id);

    expect(blockers).toEqual([]);
    expect(blockers).not.toEqual(
      expect.arrayContaining([
        "third-party-plugin-install",
        "third-party-plugin-update",
        "onboarding-plugin-install",
        "plugin-package-directory-installer",
        "stage-zero-bootstrap-install",
        "application-service-selector",
        "application-onboarding-finalizer",
        "application-tailscale-owner",
        "application-uninstall-owner",
        "application-restart-owner",
        "signer-owner-ceremony",
      ]),
    );
  });

  it("keeps the Stage-0 shell free of application and host-profile mutation", () => {
    const installer = readFileSync(path.join(repoRoot, "install.sh"), "utf8");
    for (const forbidden of [
      "node ",
      "npm ",
      "pnpm ",
      "systemctl ",
      "tailscale serve",
      "tailscale funnel",
      "firewall-cmd",
      "ufw ",
      "fail2ban",
      "useradd",
      "groupadd",
      "fased-signerd",
    ]) {
      expect(installer, `Stage-0 installer contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("keeps the Node update command non-mutating", () => {
    const update = readFileSync(
      path.join(repoRoot, "src", "cli", "update-cli", "update-command.ts"),
      "utf8",
    );
    for (const forbidden of [
      "installPluginFromNpmSpec",
      "systemctl",
      "launchctl",
      "tailscale",
      "npm install",
      "pnpm install",
      "updateSourceCheckout",
    ]) {
      expect(update, `Node update command contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});
