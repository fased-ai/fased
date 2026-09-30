// Unsigned, owner-paid contribution only. No wallet callbacks or submission.
export function compileContribution({
  sdk,
  prepared,
  owner,
  blockhash,
  lastValidBlockHeight,
  currentBlockHeight,
}) {
  const instruction = structuredClone(prepared?.instruction);
  const hexKey = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  if (
    !hexKey(owner) ||
    !hexKey(instruction?.program) ||
    !(instruction.data instanceof Uint8Array) ||
    instruction.data.length !== 17 ||
    instruction.data[0] !== 1 ||
    !Array.isArray(instruction.accounts) ||
    instruction.accounts.length !== 8 ||
    instruction.accounts[0].address !== owner ||
    instruction.accounts.some(
      (a, i) => !hexKey(a.address) || a.signer !== (i === 0) || a.writable !== i < 5,
    )
  ) {
    throw new Error("invalid contribution envelope");
  }
  if (
    ![lastValidBlockHeight, currentBlockHeight].every((v) => typeof v === "bigint" && v >= 0n) ||
    lastValidBlockHeight <= currentBlockHeight
  ) {
    throw new Error("expired transaction lifetime");
  }
  const decode = sdk.getAddressDecoder();
  const address = (h) => decode.decode(Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16)));
  sdk.assertIsBlockhash(blockhash);
  let message = sdk.createTransactionMessage({ version: 0 });
  message = sdk.setTransactionMessageFeePayer(address(owner), message);
  message = sdk.setTransactionMessageLifetimeUsingBlockhash(
    { blockhash, lastValidBlockHeight },
    message,
  );
  message = sdk.appendTransactionMessageInstruction(
    {
      programAddress: address(instruction.program),
      data: instruction.data,
      accounts: instruction.accounts.map((a) => ({
        address: address(a.address),
        role: (a.signer ? 2 : 0) + (a.writable ? 1 : 0),
      })),
    },
    message,
  );
  const transaction = sdk.compileTransaction(message);
  const wire = sdk.getTransactionEncoder().encode(transaction);
  if (
    wire.length > 1232 ||
    Object.keys(transaction.signatures).length !== 1 ||
    !(address(owner) in transaction.signatures)
  ) {
    throw new Error("unexpected transaction signers or size");
  }
  return { transaction, wire: Uint8Array.from(wire) };
}
