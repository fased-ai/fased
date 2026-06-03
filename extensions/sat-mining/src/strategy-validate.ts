export type SatValidatedStrategyOutput = {
  allocationFp: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  rationale: string;
  confidence?: "low" | "medium" | "high";
  suggestedDifficulty?: "low" | "medium" | "high" | "very-high";
};

const NORMALIZATION = 1_000_000;

function fail(reason: string): never {
  throw new Error(`invalid SAT strategy output: ${reason}`);
}

export function validateSatStrategyOutput(value: unknown): SatValidatedStrategyOutput {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail("payload must be an object");

  if (!Array.isArray(raw.allocationFp)) {
    fail("allocationFp must be an array");
  }
  if (raw.allocationFp.length !== 25) {
    fail("allocationFp must contain exactly 25 allocation buckets");
  }
  const allocationFp = raw.allocationFp.map((entry, index) => {
    if (!Number.isInteger(entry)) {
      fail(`allocationFp[${index}] must be an integer`);
    }
    if (Number(entry) < 0) {
      fail(`allocationFp[${index}] must be non-negative`);
    }
    return Number(entry);
  });
  const sum = allocationFp.reduce((acc, item) => acc + item, 0);
  if (sum !== NORMALIZATION) {
    fail(`allocationFp must sum to ${NORMALIZATION}, got ${sum}`);
  }
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) {
    fail("rationale is required");
  }
  const confidence =
    raw.confidence === "low" || raw.confidence === "medium" || raw.confidence === "high"
      ? raw.confidence
      : undefined;
  const suggestedDifficulty =
    raw.suggestedDifficulty === "low" ||
    raw.suggestedDifficulty === "medium" ||
    raw.suggestedDifficulty === "high" ||
    raw.suggestedDifficulty === "very-high"
      ? raw.suggestedDifficulty
      : undefined;

  return {
    allocationFp: allocationFp as SatValidatedStrategyOutput["allocationFp"],
    rationale,
    confidence,
    suggestedDifficulty,
  };
}
