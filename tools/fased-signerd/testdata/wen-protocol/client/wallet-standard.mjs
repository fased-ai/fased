// Use a wallet selected through Wallet Standard discovery, never a remote signer.
export const createWalletStandardSigner = (config) => walletSigner(config, false);
// Withdrawal must verify/journal the returned signature before rejecting a
// selection change. Only its guarded approval coordinator may consume this adapter.
export const createWithdrawalWalletSigner = (config) => walletSigner(config, true);
// Returned bytes must reach the staking journal even after wallet selection changes.
export const createStakingChangeWalletSigner = (config) => walletSigner(config, true);
export const createClaimWalletSigner = (config) => walletSigner(config, true);
function walletSigner({ sdk, wallet, account, owner, chain }, retainSignedResponse) {
  if (
    typeof owner !== "string" ||
    !/^[0-9a-f]{64}$/.test(owner) ||
    !["solana:devnet", "solana:testnet", "solana:mainnet", "solana:localnet"].includes(chain)
  ) {
    throw new Error("invalid wallet binding");
  }
  const ownerBytes = Uint8Array.from(owner.match(/../g), (b) => parseInt(b, 16));
  const address = sdk.getAddressDecoder().decode(ownerBytes);
  const validate = () => {
    const feature = wallet?.features?.["solana:signTransaction"];
    if (
      !wallet?.accounts?.includes(account) ||
      account.address !== address ||
      !(account.publicKey instanceof Uint8Array) ||
      account.publicKey.length !== 32 ||
      account.publicKey.some((b, i) => b !== ownerBytes[i]) ||
      !wallet.chains?.includes(chain) ||
      !account.chains?.includes(chain) ||
      !account.features?.includes("solana:signTransaction") ||
      feature?.version !== "1.0.0" ||
      !feature.supportedTransactionVersions?.includes(0) ||
      typeof feature.signTransaction !== "function"
    ) {
      throw new Error("wallet disconnected or incompatible");
    }
    return feature;
  };
  validate();
  return async (wire) => {
    if (!(wire instanceof Uint8Array) || wire.length > 1232) {
      throw new Error("invalid unsigned wire");
    }
    const feature = validate();
    const output = await feature.signTransaction({ account, chain, transaction: wire.slice() });
    if (!retainSignedResponse) {
      validate();
    }
    if (
      !Array.isArray(output) ||
      output.length !== 1 ||
      !(output[0]?.signedTransaction instanceof Uint8Array) ||
      output[0].signedTransaction.length > 1232
    ) {
      throw new Error("invalid wallet result");
    }
    return output[0].signedTransaction.slice();
  };
}
