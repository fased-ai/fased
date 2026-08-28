import { SAT_VNEXT_INTERFACE, type SatVNextAction } from "./vnext-interface-manifest.js";

type SatAccountShapeMeta = {
  isSigner: boolean;
  isWritable: boolean;
};

function expectedFlags(token: string): SatAccountShapeMeta {
  if (!/^(?:S|-)(?:W|-)$/u.test(token)) {
    throw new Error(`SAT vNext generated an invalid account-shape token ${token}`);
  }
  return {
    isSigner: token[0] === "S",
    isWritable: token[1] === "W",
  };
}

function assertFlags(
  action: SatVNextAction,
  accountIndex: number,
  expectedToken: string,
  received: SatAccountShapeMeta,
): void {
  const expected = expectedFlags(expectedToken);
  if (received.isSigner !== expected.isSigner || received.isWritable !== expected.isWritable) {
    throw new Error(
      `SAT vNext ${action} account ${accountIndex} must match ${expectedToken}, got ${received.isSigner ? "S" : "-"}${received.isWritable ? "W" : "-"}`,
    );
  }
}

export function assertSatVNextAccountShape(
  action: SatVNextAction,
  accounts: readonly SatAccountShapeMeta[],
): void {
  const codec = SAT_VNEXT_INTERFACE.actionCodecs[action];
  const tokens = codec.accountShape.split(",");
  const repeatedCount = codec.repeatedAccountGroup?.length ?? 0;
  const fixedCount = tokens.length - repeatedCount;

  if (repeatedCount === 0) {
    if (accounts.length !== tokens.length) {
      throw new Error(
        `SAT vNext ${action} requires ${tokens.length} accounts, got ${accounts.length}`,
      );
    }
  } else if (
    accounts.length < tokens.length ||
    (accounts.length - fixedCount) % repeatedCount !== 0
  ) {
    throw new Error(
      `SAT vNext ${action} requires ${fixedCount} fixed accounts plus groups of ${repeatedCount}, got ${accounts.length}`,
    );
  }

  for (let index = 0; index < Math.min(fixedCount, accounts.length); index += 1) {
    assertFlags(action, index, tokens[index]!, accounts[index]!);
  }
  if (repeatedCount > 0) {
    const repeatedTokens = tokens.slice(fixedCount);
    for (let index = fixedCount; index < accounts.length; index += 1) {
      assertFlags(
        action,
        index,
        repeatedTokens[(index - fixedCount) % repeatedCount]!,
        accounts[index]!,
      );
    }
  }
}
