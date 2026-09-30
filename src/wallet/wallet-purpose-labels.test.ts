import { expect, it } from "vitest";
import { nextWalletDisplayName, walletPurposeLabels } from "./wallet-purpose-labels.js";
it("does not expose legacy authority roles as purpose labels", () => {
  const metadata = { role: "mining", purpose: "mining", controller: "owner" };
  expect(walletPurposeLabels(metadata)).toEqual([]);
  expect(metadata).toEqual({ role: "mining", purpose: "mining", controller: "owner" });
});
it("supports several optional purposes while an explicit empty list stays empty", () => {
  expect(walletPurposeLabels({ role: "agent", purposeLabels: ["WEN", "News", "WEN"] })).toEqual([
    "WEN",
    "News",
  ]);
  expect(walletPurposeLabels({ role: "agent", purposeLabels: [] })).toEqual([]);
  expect(walletPurposeLabels({ purposeLabels: ["WEN", { allowSigning: true }] })).toEqual([]);
  expect(walletPurposeLabels({ purposeLabels: Array(9).fill("WEN") })).toEqual([]);
});

it("allocates distinct display names without changing wallet identities", () => {
  expect(nextWalletDisplayName([])).toBe("Wallet");
  expect(
    nextWalletDisplayName([{ name: "wallet" }, { name: "Wallet 2" }, { name: "Savings" }]),
  ).toBe("Wallet 3");
});
