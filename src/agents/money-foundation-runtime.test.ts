import { Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { WalletProviderMoneyFoundationIntentV2 } from "../wallet/wallet-provider-adapter.js";
import {
  deriveMoneyFoundationRequestId,
  prepareMoneyFoundationTransactionEnvelope,
} from "./money-foundation-runtime.js";

function intent(wallet: string, positionMint: string): WalletProviderMoneyFoundationIntentV2 {
  return {
    type: "solana.moneyFoundationAction",
    cluster: "devnet",
    moneyFoundation: {
      contractGeneration: 1,
      policyGeneration: "1",
      policyDigestSha256: "a".repeat(64),
      action: "ADD_POL",
      sourceClass: "OWNER_SEED",
      sourceOwner: wallet,
      destinationOwner: wallet,
      lifecycle: "ENABLED",
      fundingAuthorized: true,
      publicEntryEnabled: false,
      liquidityTreasury: wallet,
      emergencyAuthority: Keypair.generate().publicKey.toBase58(),
      emergencyUnwindNotBeforeSlot: "0",
      satMint: "BbZ7cUmbD9s43jeqK65Jjg8QWo5VNMZovKURVEYx4DqU", // pragma: allowlist secret
      satTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // pragma: allowlist secret
      wrappedSolMint: "So11111111111111111111111111111111111111112",
      venueProgram: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // pragma: allowlist secret
      poolConfig: "9xKsCsiv8eeBohobb8Z1snLZzVKKATGqmY69vJHyCzvu", // pragma: allowlist secret
      pool: "2jLvTwU9f9s9wHbnR8Lkq8xMqeSbuws5RRW1cYDua2DK", // pragma: allowlist secret
      positionMint,
      positionTokenAccount: Keypair.generate().publicKey.toBase58(),
      satVault: Keypair.generate().publicKey.toBase58(),
      solVault: Keypair.generate().publicKey.toBase58(),
      initialSatRaw: "50000000000",
      initialSolLamports: "2500000",
      inputRaw: "50000000000",
      minimumSatRaw: "0",
      minimumSolLamports: "0",
      maxSlippageBps: 100,
      maxPriceImpactBps: 1000,
      maxCombinedFeeBps: 1000,
      simulationSlot: "100",
      expiresSlot: "200",
      sourceDescriptorSha256: "b".repeat(64),
      protectedCapitalAddresses: [Keypair.generate().publicKey.toBase58()],
    },
  };
}

function transaction(wallet: Keypair, positionMint: Keypair): Transaction {
  return new Transaction({
    feePayer: wallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: positionMint.publicKey, isSigner: true, isWritable: true },
      ],
      data: Buffer.from([1]),
    }),
  );
}

describe("money-foundation runtime", () => {
  it("pre-signs only the one-use position mint and derives a stable request", () => {
    const wallet = Keypair.generate();
    const positionMint = Keypair.generate();
    const semantic = intent(wallet.publicKey.toBase58(), positionMint.publicKey.toBase58());
    const envelope = prepareMoneyFoundationTransactionEnvelope({
      transaction: transaction(wallet, positionMint),
      intent: semantic,
      walletPublicKey: wallet.publicKey.toBase58(),
      positionMintSigner: positionMint,
    });
    const decoded = Transaction.from(Buffer.from(envelope.serializedTxBase64, "base64"));
    expect(decoded.signatures[0]?.signature).toBeNull();
    expect(decoded.signatures[1]?.publicKey.toBase58()).toBe(positionMint.publicKey.toBase58());
    expect(decoded.signatures[1]?.signature).not.toBeNull();
    expect(
      deriveMoneyFoundationRequestId({
        walletId: "vault-pol",
        workflowId: "p4-009",
        intent: semantic,
        transaction: envelope,
      }),
    ).toMatch(/^money-foundation-[0-9a-f]{48}$/u);
  });

  it("rejects a substituted ephemeral signer", () => {
    const wallet = Keypair.generate();
    const positionMint = Keypair.generate();
    expect(() =>
      prepareMoneyFoundationTransactionEnvelope({
        transaction: transaction(wallet, positionMint),
        intent: intent(wallet.publicKey.toBase58(), positionMint.publicKey.toBase58()),
        walletPublicKey: wallet.publicKey.toBase58(),
        positionMintSigner: Keypair.generate(),
      }),
    ).toThrow("exact one-use position-mint signer");
  });
});
