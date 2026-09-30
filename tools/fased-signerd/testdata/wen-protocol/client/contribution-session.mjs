import { compileContribution } from "./transaction.mjs";
import { verifyWalletComputeBudgetAdjustment } from "./wallet-compute-budget.mjs";
// App owns the RPC transport and verified planner. Preparation never invokes a wallet.
export function createContributionSession(options) {
  return createOwnerSession({
    ...options,
    compile: compileContribution,
    describe: (intent) => ({
      owner: intent.accounts.owner,
      program: intent.program,
      amount: intent.amount,
      mint: intent.accounts.mint,
      escrow: intent.accounts.escrow,
    }),
  });
}
// Shared transport lifecycle. Product wrappers own instruction validation and quotes.
export function createOwnerSession({
  sdk,
  planner,
  rpc,
  journal,
  genesis,
  maxFeeLamports,
  maxSlotLag = 32n,
  sendMaxRetries = 0n,
  transactionCommitment = "finalized",
  refreshBeforeSign = false,
  allowNewerFeeContext = false,
  allowWalletComputeBudget = false,
  reviewFeeCap = false,
  compile,
  describe,
  quoteCosts,
  recoveryRecord,
  onWalletDiagnostic,
}) {
  if (typeof journal?.put !== "function" || typeof journal?.get !== "function") {
    throw new Error("persistent submission journal required");
  }
  if (
    typeof maxFeeLamports !== "bigint" ||
    maxFeeLamports < 0n ||
    typeof maxSlotLag !== "bigint" ||
    maxSlotLag < 0n ||
    typeof sendMaxRetries !== "bigint" ||
    sendMaxRetries < 0n ||
    sendMaxRetries > 5n ||
    !["finalized", "confirmed"].includes(transactionCommitment) ||
    typeof refreshBeforeSign !== "boolean" ||
    typeof allowNewerFeeContext !== "boolean" ||
    typeof allowWalletComputeBudget !== "boolean" ||
    typeof reviewFeeCap !== "boolean" ||
    (reviewFeeCap && !allowWalletComputeBudget)
  ) {
    throw new Error("explicit fee and freshness limits required");
  }
  if (onWalletDiagnostic !== undefined && typeof onWalletDiagnostic !== "function") {
    throw new Error("invalid wallet diagnostic sink");
  }
  const pending = new WeakMap();
  const bytes64 = (b) => btoa(String.fromCharCode(...b));
  const slot = (v) => typeof v === "bigint" && v >= 0n;
  const hash = async (b) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
  const diagnostic = (record) => {
    try {
      onWalletDiagnostic?.(structuredClone(record));
    } catch {
      /* diagnostics cannot change custody */
    }
  };
  async function cluster() {
    if ((await rpc.getGenesisHash().send()) !== genesis) {
      throw new Error("wrong cluster");
    }
  }
  async function costs(compiled, minSlot, limit, phase = "reviewed") {
    const fee = await rpc
      .getFeeForMessage(bytes64(compiled.transaction.messageBytes), {
        commitment: transactionCommitment,
        minContextSlot: minSlot,
      })
      .send();
    if (fee?.value === null) {
      throw new Error(
        `RPC returned no fee for ${phase} message; its blockhash or fee context is unavailable`,
      );
    }
    if (!slot(fee?.context?.slot) || fee.context.slot < minSlot) {
      throw new Error(`RPC returned stale fee context for ${phase} message`);
    }
    if ((!limit || !allowNewerFeeContext) && fee.context.slot - minSlot > maxSlotLag) {
      throw new Error(`RPC fee context exceeded freshness limit for ${phase} message`);
    }
    if (!slot(fee.value)) {
      throw new Error(`RPC returned invalid fee for ${phase} message`);
    }
    if (fee.value > maxFeeLamports) {
      throw new Error(
        limit && reviewFeeCap
          ? `Signed network fee ${fee.value} exceeds reviewed maximum ${maxFeeLamports} lamports`
          : "invalid current fee",
      );
    }
    if (limit && fee.value > limit.networkFeeLamports) {
      throw new Error("cost increased after approval");
    }
    if (!quoteCosts) {
      return { networkFeeLamports: fee.value };
    }
    const result = await quoteCosts({
      networkFeeLamports: fee.value,
      minSlot: fee.context.slot,
      transactionCommitment,
      costContext: structuredClone(compiled.costContext),
    });
    if (
      limit &&
      (fee.value > limit.networkFeeLamports ||
        result.totalCostLamports > limit.totalCostLamports ||
        result.rentLamports > limit.rentLamports)
    ) {
      throw new Error("cost increased after approval");
    }
    return { ...result, networkFeeLamports: fee.value };
  }
  async function simulate(wire, minSlot, signed) {
    const result = await rpc
      .simulateTransaction(bytes64(wire), {
        encoding: "base64",
        commitment: transactionCommitment,
        minContextSlot: minSlot,
        sigVerify: signed,
        replaceRecentBlockhash: false,
      })
      .send();
    if (
      !slot(result?.context?.slot) ||
      result.context.slot < minSlot ||
      (!signed && result.context.slot - minSlot > maxSlotLag) ||
      !result.value ||
      result.value.err !== null
    ) {
      throw new Error("simulation failed or stale");
    }
    return result;
  }
  return {
    async prepare(input, policy) {
      const intent = structuredClone(input),
        bounds = structuredClone(policy);
      if (bounds.genesis !== genesis) {
        throw new Error("wrong policy cluster");
      }
      await cluster();
      const prepared = await planner(intent, bounds);
      const latest = await rpc
        .getLatestBlockhash({ commitment: transactionCommitment, minContextSlot: prepared.slot })
        .send();
      if (
        !slot(latest?.context?.slot) ||
        latest.context.slot < prepared.slot ||
        latest.context.slot - prepared.slot > maxSlotLag
      ) {
        throw new Error("stale blockhash context");
      }
      const height = await rpc
        .getBlockHeight({ commitment: transactionCommitment, minContextSlot: latest.context.slot })
        .send();
      const compiled = compile({
        sdk,
        prepared,
        owner: intent.accounts.owner,
        program: intent.program,
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: latest.value.lastValidBlockHeight,
        currentBlockHeight: height,
      });
      const fee = await rpc
        .getFeeForMessage(bytes64(compiled.transaction.messageBytes), {
          commitment: transactionCommitment,
          minContextSlot: latest.context.slot,
        })
        .send();
      if (
        !slot(fee?.context?.slot) ||
        fee.context.slot < latest.context.slot ||
        fee.context.slot - latest.context.slot > maxSlotLag ||
        !slot(fee.value) ||
        fee.value > maxFeeLamports
      ) {
        throw new Error("invalid or excessive network fee");
      }
      await simulate(compiled.wire, latest.context.slot, false);
      const costQuote = await costs(compiled, latest.context.slot);
      const reviewedCosts =
        reviewFeeCap && quoteCosts
          ? await quoteCosts({
              networkFeeLamports: maxFeeLamports,
              minSlot: latest.context.slot,
              transactionCommitment,
              costContext: structuredClone(compiled.costContext),
            })
          : costQuote;
      const ticket = Object.freeze({
        ...describe(intent, prepared),
        genesis,
        ...reviewedCosts,
        networkFeeLamports: reviewFeeCap ? maxFeeLamports : fee.value,
        ...(reviewFeeCap ? { estimatedNetworkFeeLamports: fee.value } : {}),
        lastValidBlockHeight: latest.value.lastValidBlockHeight,
      });
      pending.set(ticket, {
        ...compiled,
        minSlot: latest.context.slot,
        state: "prepared",
        preparedAtMs: Date.now(),
        recompile: { prepared, owner: intent.accounts.owner, program: intent.program },
      });
      return ticket;
    },
    // Invoke only following explicit user approval of the ticket. Wallet signs only.
    async submit(ticket, signTransaction, guard = () => {}) {
      if (typeof guard !== "function") {
        throw new Error("invalid submission guard");
      }
      guard();
      const item = pending.get(ticket);
      if (!item || item.state !== "prepared" || typeof signTransaction !== "function") {
        throw new Error("invalid or consumed ticket");
      }
      item.state = "consumed"; // Ambiguous errors never cause automatic re-sign/send.
      await cluster();
      const height = await rpc
        .getBlockHeight({ commitment: transactionCommitment, minContextSlot: item.minSlot })
        .send();
      let signingHeight = height;
      if (!slot(height) || (!refreshBeforeSign && height + 32n >= ticket.lastValidBlockHeight)) {
        throw new Error("ticket too close to expiry; review again");
      }
      if (!refreshBeforeSign) {
        await costs(item, item.minSlot, ticket);
      }
      if (refreshBeforeSign) {
        const fresh = await rpc
          .getLatestBlockhash({ commitment: transactionCommitment, minContextSlot: item.minSlot })
          .send();
        if (
          !slot(fresh?.context?.slot) ||
          fresh.context.slot < item.minSlot ||
          !fresh.value?.blockhash ||
          !slot(fresh.value.lastValidBlockHeight)
        ) {
          throw new Error("invalid refreshed blockhash");
        }
        const freshHeight = await rpc
          .getBlockHeight({ commitment: transactionCommitment, minContextSlot: fresh.context.slot })
          .send();
        if (!slot(freshHeight) || freshHeight + 32n >= fresh.value.lastValidBlockHeight) {
          throw new Error("insufficient refreshed blockhash lifetime");
        }
        signingHeight = freshHeight;
        const rebuilt = compile({
          sdk,
          ...item.recompile,
          blockhash: fresh.value.blockhash,
          lastValidBlockHeight: fresh.value.lastValidBlockHeight,
          currentBlockHeight: freshHeight,
        });
        await simulate(rebuilt.wire, fresh.context.slot, false);
        await costs(rebuilt, fresh.context.slot, ticket);
        Object.assign(item, rebuilt, {
          minSlot: fresh.context.slot,
          lastValidBlockHeight: fresh.value.lastValidBlockHeight,
        });
      }
      guard();
      const validUntil = item.lastValidBlockHeight ?? ticket.lastValidBlockHeight;
      const expectedMessage = item.transaction.messageBytes;
      const report = {
        schema: "wen.market-wallet-diagnostic.v1",
        phase: "before-wallet",
        reviewedMessageSha256: await hash(expectedMessage),
        reviewedMessageBytes: expectedMessage.length,
        reviewedBlockhash: sdk.getCompiledTransactionMessageDecoder().decode(expectedMessage)
          .lifetimeToken,
        quoteAgeMs: Math.max(0, Date.now() - item.preparedAtMs),
        signingBlockHeight: signingHeight.toString(),
        lastValidBlockHeight: validUntil.toString(),
        estimatedNetworkFeeLamports: (
          ticket.estimatedNetworkFeeLamports ?? ticket.networkFeeLamports
        ).toString(),
        reviewedMaximumFeeLamports: ticket.networkFeeLamports.toString(),
      };
      diagnostic(report);
      const returned = await signTransaction(item.wire.slice());
      if (!(returned instanceof Uint8Array) || returned.length > 1232) {
        throw new Error("invalid signed wire");
      }
      const wire = returned.slice(),
        signed = sdk.getTransactionDecoder().decode(wire);
      const firstDifference = signed.messageBytes.findIndex((b, i) => b !== expectedMessage[i]);
      const changed =
        signed.messageBytes.length !== expectedMessage.length || firstDifference !== -1;
      let signedBlockhash = null;
      try {
        signedBlockhash = sdk
          .getCompiledTransactionMessageDecoder()
          .decode(signed.messageBytes).lifetimeToken;
      } catch {
        /* malformed wallet output remains rejected by message verification */
      }
      Object.assign(report, {
        phase: "wallet-returned",
        signedMessageSha256: await hash(signed.messageBytes),
        signedMessageBytes: signed.messageBytes.length,
        signedBlockhash,
        firstDifference:
          firstDifference < 0
            ? Math.min(expectedMessage.length, signed.messageBytes.length)
            : firstDifference,
        messageChanged: changed,
      });
      diagnostic(report);
      if (changed) {
        const detail = `wallet changed message: expected ${expectedMessage.length} bytes, received ${signed.messageBytes.length}; first difference at ${firstDifference < 0 ? Math.min(expectedMessage.length, signed.messageBytes.length) : firstDifference}`;
        if (!allowWalletComputeBudget) {
          throw Error(detail);
        }
        try {
          verifyWalletComputeBudgetAdjustment(sdk, expectedMessage, signed.messageBytes);
        } catch (cause) {
          throw Error(`${detail}; ${cause.message}`, { cause: cause });
        }
      }
      const ownerBytes = Uint8Array.from(ticket.owner.match(/../g), (b) => parseInt(b, 16));
      const owner = sdk.getAddressDecoder().decode(ownerBytes),
        signature = signed.signatures[owner];
      const key = await crypto.subtle.importKey("raw", ownerBytes, { name: "Ed25519" }, false, [
        "verify",
      ]);
      if (
        Object.keys(signed.signatures).length !== 1 ||
        !(signature instanceof Uint8Array) ||
        signature.length !== 64 ||
        !(await crypto.subtle.verify("Ed25519", key, signature, signed.messageBytes))
      ) {
        throw new Error("invalid owner signature");
      }
      // An added priority fee must fit the amount the owner reviewed. Check
      // the wallet's actual message before recording or attempting broadcast.
      if (changed) {
        const signedCost = await costs(
          { transaction: signed, costContext: item.costContext },
          item.minSlot,
          ticket,
          "wallet-signed",
        );
        Object.assign(report, {
          phase: "signed-fee-verified",
          signedNetworkFeeLamports: signedCost.networkFeeLamports.toString(),
        });
        diagnostic(report);
      }
      const expected = sdk.getSignatureFromTransaction(signed);
      const messageHash = await hash(signed.messageBytes);
      const record = {
        version: 1,
        genesis,
        signature: expected,
        owner: ticket.owner,
        program: ticket.program,
        minSlot: item.minSlot.toString(),
        lastValidBlockHeight: validUntil.toString(),
        signedMessage: {
          base64: bytes64(signed.messageBytes),
          sha256: messageHash,
          blockhash: sdk.getCompiledTransactionMessageDecoder().decode(signed.messageBytes)
            .lifetimeToken,
        },
        ...(recoveryRecord ? { recovery: structuredClone(recoveryRecord(ticket)) } : {}),
      };
      try {
        await journal.put(record);
        if (JSON.stringify(await journal.get(expected)) !== JSON.stringify(record)) {
          throw new Error("journal persistence mismatch");
        }
        guard();
        await cluster();
        const afterSigning = await rpc
          .getBlockHeight({ commitment: transactionCommitment, minContextSlot: item.minSlot })
          .send();
        if (!slot(afterSigning) || afterSigning >= validUntil) {
          throw new Error("expired after wallet approval");
        }
        // A wallet may take longer than the read-preview slot window. The signed
        // message is unchanged; simulation checks it against current chain state.
        const signedSimulation = await simulate(wire, item.minSlot, true);
        const submitSlot = signedSimulation.context.slot;
        const currentHeight = await rpc
          .getBlockHeight({ commitment: transactionCommitment, minContextSlot: submitSlot })
          .send();
        if (!slot(currentHeight) || currentHeight >= validUntil) {
          throw new Error("expired after signed simulation");
        }
        await costs(
          { transaction: signed, costContext: item.costContext },
          submitSlot,
          ticket,
          "wallet-signed",
        );
        const readyHeight = await rpc
          .getBlockHeight({ commitment: transactionCommitment, minContextSlot: submitSlot })
          .send();
        if (!slot(readyHeight) || readyHeight + 32n >= validUntil) {
          throw new Error("insufficient blockhash lifetime for submission");
        }
        guard();
        item.signature = expected;
        item.state = "submission-unknown";
        const actual = await rpc
          .sendTransaction(bytes64(wire), {
            encoding: "base64",
            skipPreflight: false,
            preflightCommitment: transactionCommitment,
            minContextSlot: submitSlot,
            maxRetries: sendMaxRetries,
          })
          .send();
        if (actual !== expected) {
          throw new Error(
            "submission signature mismatch; reconcile expected signature " + expected,
          );
        }
        item.state = "submitted";
        return Object.freeze({
          signature: expected,
          status: "submitted",
          lastValidBlockHeight: validUntil,
        });
      } catch (cause) {
        throw Object.assign(new Error(cause?.message ?? "signed submission failed", { cause }), {
          signature: expected,
        });
      }
    },
    async recover(signature) {
      sdk.assertIsSignature(signature);
      const record = await journal.get(signature);
      const number = (v) =>
        typeof v === "string" &&
        /^(0|[1-9][0-9]{0,19})$/.test(v) &&
        BigInt(v) <= 0xffffffffffffffffn;
      if (
        !record ||
        record.version !== 1 ||
        record.genesis !== genesis ||
        record.signature !== signature ||
        ![record.owner, record.program].every(
          (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
        ) ||
        !number(record.minSlot) ||
        !number(record.lastValidBlockHeight)
      ) {
        throw new Error("invalid recovery record");
      }
      if (record.signedMessage) {
        await authenticateOwnerJournalMessage(sdk, record);
      }
      const ticket = Object.freeze({
        owner: record.owner,
        program: record.program,
        genesis,
        lastValidBlockHeight: BigInt(record.lastValidBlockHeight),
      });
      pending.set(ticket, { signature, minSlot: BigInt(record.minSlot), state: "recovery-only" });
      return ticket;
    },
    async reconcile(ticket) {
      const item = pending.get(ticket);
      if (!item?.signature) {
        throw new Error("no attempted submission");
      }
      await cluster();
      const response = await rpc
        .getSignatureStatuses([item.signature], { searchTransactionHistory: true })
        .send();
      if (
        !slot(response?.context?.slot) ||
        response.context.slot < item.minSlot ||
        !Array.isArray(response.value) ||
        response.value.length !== 1
      ) {
        throw new Error("invalid signature status");
      }
      const status = response.value[0];
      if (status !== null) {
        if (
          !slot(status.slot) ||
          status.slot < item.minSlot ||
          status.slot > response.context.slot ||
          !["processed", "confirmed", "finalized"].includes(status.confirmationStatus) ||
          !("err" in status)
        ) {
          throw new Error("invalid transaction status");
        }
        return Object.freeze({
          signature: item.signature,
          status: status.err !== null ? "failed" : status.confirmationStatus,
          error: status.err,
          slot: status.slot,
        });
      }
      const height = await rpc
        .getBlockHeight({ commitment: "finalized", minContextSlot: item.minSlot })
        .send();
      if (!slot(height)) {
        throw new Error("invalid block height");
      }
      return Object.freeze({
        signature: item.signature,
        status: height > ticket.lastValidBlockHeight ? "expired-unobserved" : "pending",
      });
    },
  };
}

// Optional on older journals. Missing provenance never authorizes retirement.
export async function authenticateOwnerJournalMessage(sdk, record) {
  const saved = record.signedMessage;
  if (
    !saved ||
    typeof saved.base64 !== "string" ||
    saved.base64.length > 1644 ||
    !/^([0-9a-f]{64})$/.test(saved.sha256)
  ) {
    throw Error("signed journal provenance unavailable");
  }
  const bytes = Uint8Array.from(atob(saved.base64), (c) => c.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (btoa(String.fromCharCode(...bytes)) !== saved.base64 || hash !== saved.sha256) {
    throw Error("signed journal message changed");
  }
  const msg = sdk.getCompiledTransactionMessageDecoder().decode(bytes),
    owner = sdk
      .getAddressDecoder()
      .decode(Uint8Array.from(record.owner.match(/../g), (b) => parseInt(b, 16))),
    program = sdk
      .getAddressDecoder()
      .decode(Uint8Array.from(record.program.match(/../g), (b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    sdk.getAddressEncoder().encode(owner),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (
    msg.staticAccounts[0] !== owner ||
    !msg.staticAccounts.includes(program) ||
    msg.lifetimeToken !== saved.blockhash ||
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      sdk.getBase58Encoder().encode(record.signature),
      bytes,
    ))
  ) {
    throw Error("signed journal signature or binding changed");
  }
  return { bytes, message: msg, sha256: hash };
}
