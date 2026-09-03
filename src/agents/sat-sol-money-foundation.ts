import AjvPkg from "ajv/dist/2020.js";
import {
  FASED_SAT_SOL_MONEY_FOUNDATION_SCHEMA,
  type SatSolMoneyFoundationRecord,
} from "./fased-sat-sol-money-foundation.generated.js";

const Ajv = AjvPkg as unknown as new (options: object) => {
  compile: (schema: object) => ((value: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string; message?: string }> | null;
  };
};
const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
  FASED_SAT_SOL_MONEY_FOUNDATION_SCHEMA,
);

export type SatSolMoneyFoundationValidation =
  | { ok: true; value: SatSolMoneyFoundationRecord }
  | { ok: false; errors: string[] };

const U64_MAX = 18_446_744_073_709_551_615n;

function u64Errors(record: SatSolMoneyFoundationRecord, fields: readonly string[]): string[] {
  const values = record as unknown as Record<string, unknown>;
  return fields.flatMap((field) => {
    const value = values[field];
    return typeof value === "string" && BigInt(value) <= U64_MAX
      ? []
      : [`${field} exceeds the unsigned 64-bit range`];
  });
}

function semanticErrors(value: SatSolMoneyFoundationRecord): string[] {
  switch (value.schema) {
    case "fased.sat-sol-market-policy.v1": {
      const errors = u64Errors(value, ["policyGeneration", "initialSatRaw", "initialSolLamports"]);
      if (value.lifecycle === "DISABLED" && (value.publicEntryEnabled || value.fundingAuthorized)) {
        errors.push("disabled policy cannot authorize entry or funding");
      }
      return errors;
    }
    case "fased.sat-sol-market-binding.v1": {
      const errors = u64Errors(value, [
        "policyGeneration",
        "finalizedSlot",
        "satReserveRaw",
        "solReserveLamports",
      ]);
      if (
        value.lifecycle === "ENABLED" &&
        (!value.immutableConfig || !value.custodyVerified || !value.publicEntryEnabled)
      ) {
        errors.push("enabled market requires immutable config, verified custody and public entry");
      }
      return errors;
    }
    case "fased.sat-sol-transaction-review.v1": {
      const errors = u64Errors(value, [
        "policyGeneration",
        "inputRaw",
        "minimumOutputRaw",
        "simulationSlot",
        "expiresSlot",
      ]);
      if (BigInt(value.expiresSlot) <= BigInt(value.simulationSlot)) {
        errors.push("expiresSlot must follow simulationSlot");
      }
      if (
        value.decision === "APPROVED" &&
        (!value.fixedDestination || value.protectedCapitalReachable)
      ) {
        errors.push(
          "approved review requires a fixed destination and unreachable protected capital",
        );
      }
      return errors;
    }
    case "fased.sat-sol-pol-custody.v1": {
      const errors = u64Errors(value, ["policyGeneration"]);
      if (
        value.miningVaultPrincipalReachable ||
        value.bondPrincipalReachable ||
        value.keeperReserveReachable ||
        value.pendingClaimsReachable ||
        value.protectedAgentReserveReachable ||
        value.ownerHotWalletCanWithdraw
      ) {
        errors.push("protected capital and hot-wallet withdrawal must remain unreachable");
      }
      return errors;
    }
    case "fased.sat-sol-emergency-unwind-receipt.v1": {
      const errors = u64Errors(value, [
        "policyGeneration",
        "finalizedSlot",
        "satBeforeRaw",
        "solBeforeLamports",
        "satRecoveredRaw",
        "solRecoveredLamports",
        "remainingPositionRaw",
      ]);
      if (value.positionClosed && value.remainingPositionRaw !== "0") {
        errors.push("closed position must have zero remaining position");
      }
      return errors;
    }
  }
}

export function validateSatSolMoneyFoundationRecord(
  value: unknown,
): SatSolMoneyFoundationValidation {
  if (!validateSchema(value)) {
    return {
      ok: false,
      errors: (validateSchema.errors ?? []).map(
        (error) => `${error.instancePath || "<root>"}: ${error.message ?? "invalid"}`,
      ),
    };
  }
  const record = value as SatSolMoneyFoundationRecord;
  const errors = semanticErrors(record);
  return errors.length === 0 ? { ok: true, value: record } : { ok: false, errors };
}
