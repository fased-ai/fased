import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount, WalletWithFeatures } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";

type CompatibleWallet = WalletWithFeatures<StandardConnectFeature & SolanaSignTransactionFeature>;

export type WalletStandardAccountSelection = {
  wallet: CompatibleWallet;
  account: WalletAccount;
};

export type WalletStandardChooser = (params: { title: string; options: string[] }) => number | null;

function isCompatibleWallet(wallet: Wallet): wallet is CompatibleWallet {
  return StandardConnect in wallet.features && SolanaSignTransaction in wallet.features;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 8_192;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function chooseIndex(params: {
  title: string;
  options: string[];
  chooser?: WalletStandardChooser;
}): number {
  if (params.options.length === 1) {
    return 0;
  }
  const selected = params.chooser?.({ title: params.title, options: params.options }) ?? null;
  if (
    selected == null ||
    !Number.isInteger(selected) ||
    selected < 0 ||
    selected >= params.options.length
  ) {
    throw new Error(`${params.title} was cancelled`);
  }
  return selected;
}

function accountSupportsSolana(account: WalletAccount): boolean {
  return account.chains.some((chain) => chain.startsWith("solana:"));
}

async function connectWallet(wallet: CompatibleWallet): Promise<readonly WalletAccount[]> {
  const connected = await wallet.features[StandardConnect].connect();
  return connected.accounts.length > 0 ? connected.accounts : wallet.accounts;
}

export async function connectWalletStandardAccount(params?: {
  expectedAddress?: string;
  chooser?: WalletStandardChooser;
}): Promise<WalletStandardAccountSelection> {
  const expectedAddress = params?.expectedAddress?.trim() || "";
  const wallets = getWallets().get().filter(isCompatibleWallet);
  if (wallets.length === 0) {
    throw new Error(
      "No compatible Solana wallet was found. Install a Wallet Standard wallet and connect the account you intend to use. For reserve funds, use and verify a hardware-backed account on its device.",
    );
  }
  const alreadyMatching = expectedAddress
    ? wallets.find((wallet) =>
        wallet.accounts.some((account) => account.address === expectedAddress),
      )
    : undefined;
  const wallet =
    alreadyMatching ??
    wallets[
      chooseIndex({
        title: "Choose a Solana wallet",
        options: wallets.map((candidate) => candidate.name),
        chooser: params?.chooser,
      })
    ];
  const accounts = (await connectWallet(wallet)).filter(accountSupportsSolana);
  if (accounts.length === 0) {
    throw new Error(`${wallet.name} did not expose a Solana account`);
  }
  const matchingAccount = expectedAddress
    ? accounts.find((account) => account.address === expectedAddress)
    : undefined;
  if (expectedAddress && !matchingAccount) {
    throw new Error(
      `${wallet.name} is not connected to the reviewed account ${expectedAddress}; switch accounts and try again`,
    );
  }
  const account =
    matchingAccount ??
    accounts[
      chooseIndex({
        title: "Choose a Solana account",
        options: accounts.map((candidate) => candidate.label || candidate.address),
        chooser: params?.chooser,
      })
    ];
  return { wallet, account };
}

export async function signWalletStandardTransaction(params: {
  unsignedTxBase64: string;
  expectedAddress: string;
  chain: "solana:mainnet" | "solana:devnet";
  chooser?: WalletStandardChooser;
}): Promise<{ signedTxBase64: string; walletName: string; accountAddress: string }> {
  const selection = await connectWalletStandardAccount({
    expectedAddress: params.expectedAddress,
    chooser: params.chooser,
  });
  if (!selection.account.chains.includes(params.chain)) {
    throw new Error(
      `Connected account does not advertise ${params.chain}; switch the wallet network and try again`,
    );
  }
  const outputs = await selection.wallet.features[SolanaSignTransaction].signTransaction({
    account: selection.account,
    transaction: decodeBase64(params.unsignedTxBase64),
    chain: params.chain,
    options: { preflightCommitment: "confirmed" },
  });
  const signed = outputs[0]?.signedTransaction;
  if (!signed || signed.length === 0) {
    throw new Error("Wallet returned no signed Solana transaction");
  }
  return {
    signedTxBase64: encodeBase64(signed),
    walletName: selection.wallet.name,
    accountAddress: selection.account.address,
  };
}
