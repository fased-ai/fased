export const RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES = [
  "exec.approvals.",
  "config.",
  "wizard.",
  "update.",
] as const;

export const RESERVED_ADMIN_GATEWAY_METHOD_SCOPE = "operator.admin" as const;

export function isReservedAdminGatewayMethod(method: string): boolean {
  return RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export function resolveReservedGatewayMethodScope(
  method: string,
): typeof RESERVED_ADMIN_GATEWAY_METHOD_SCOPE | undefined {
  return isReservedAdminGatewayMethod(method) ? RESERVED_ADMIN_GATEWAY_METHOD_SCOPE : undefined;
}

export function normalizePluginGatewayMethodScope<TScope extends string>(
  method: string,
  scope: TScope | undefined,
): {
  scope: TScope | typeof RESERVED_ADMIN_GATEWAY_METHOD_SCOPE | undefined;
  coercedToReservedAdmin: boolean;
} {
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (!reservedScope || !scope || scope === reservedScope) {
    return {
      scope,
      coercedToReservedAdmin: false,
    };
  }
  return {
    scope: reservedScope,
    coercedToReservedAdmin: true,
  };
}
