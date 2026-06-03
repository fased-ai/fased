type ModelDisplaySelectionParams = {
  runtimeProvider?: unknown;
  runtimeModel?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  fallbackModel?: unknown;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveModelDisplayRef(params: ModelDisplaySelectionParams): string | undefined {
  const runtimeModel = normalizeOptionalString(params.runtimeModel);
  const runtimeProvider = normalizeOptionalString(params.runtimeProvider);
  if (runtimeModel) {
    if (runtimeModel.includes("/")) {
      return runtimeModel;
    }
    return runtimeProvider ? `${runtimeProvider}/${runtimeModel}` : runtimeModel;
  }
  if (runtimeProvider) {
    return runtimeProvider;
  }

  const overrideModel = normalizeOptionalString(params.overrideModel);
  const overrideProvider = normalizeOptionalString(params.overrideProvider);
  if (overrideModel) {
    if (overrideModel.includes("/")) {
      return overrideModel;
    }
    return overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel;
  }
  if (overrideProvider) {
    return overrideProvider;
  }

  return normalizeOptionalString(params.fallbackModel);
}

export function resolveModelDisplayName(params: ModelDisplaySelectionParams): string {
  const modelRef = resolveModelDisplayRef(params);
  if (!modelRef) {
    return "model n/a";
  }
  const slash = modelRef.lastIndexOf("/");
  if (slash >= 0 && slash < modelRef.length - 1) {
    return modelRef.slice(slash + 1);
  }
  return modelRef;
}
