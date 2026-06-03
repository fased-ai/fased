import { isMutatingAdminRpcRateLimitedMethod } from "../gateway/mutating-admin-rpc-rate-limit.js";
import type { MutatingAdminRpcRateLimitMethod } from "../gateway/mutating-admin-rpc-rate-limit.js";

export type AcpxMutatingWrapperId =
  | "fased_chat_inject_request"
  | "fased_push_test_request"
  | "fased_web_login_start_request"
  | "fased_web_login_wait_request";

export type AcpxMutatingWrapperGate =
  | "operator-scope"
  | "operator-confirmation"
  | "plugin-admin-rpc-grant"
  | "plugin-source-allowlist"
  | "audit"
  | "rate-limit"
  | "gateway-token"
  | "explicit-wrapper-enable";

export type AcpxMutatingWrapperForbiddenSurface =
  | "generic-gateway-dispatcher"
  | "client-supplied-mcpServers"
  | "cli-mcp"
  | "untrusted-plugin-source"
  | "bulk-enable-all-admin-rpcs";

export type AcpxMutatingWrapperDesign = {
  id: AcpxMutatingWrapperId;
  method: MutatingAdminRpcRateLimitMethod;
  status: "design-only";
  executionEnabled: boolean;
  description: string;
  requiredGates: readonly AcpxMutatingWrapperGate[];
  forbiddenSurfaces: readonly AcpxMutatingWrapperForbiddenSurface[];
};

export type AcpxMutatingWrapperGateState = Partial<Record<AcpxMutatingWrapperGate, boolean>>;

export type AcpxMutatingWrapperForbiddenSurfaceState = Partial<
  Record<AcpxMutatingWrapperForbiddenSurface, boolean>
>;

export type AcpxMutatingWrapperRuntimeGateInput = {
  wrapperId: string;
  gates?: AcpxMutatingWrapperGateState;
  forbiddenSurfaces?: AcpxMutatingWrapperForbiddenSurfaceState;
  allowWrappers?: readonly string[];
  denyWrappers?: readonly string[];
};

export type AcpxMutatingWrapperRuntimeGateDecision = {
  wrapperId: string;
  method?: MutatingAdminRpcRateLimitMethod;
  allowed: boolean;
  reason:
    | "allowed"
    | "unknown-wrapper"
    | "denied-wrapper"
    | "not-allowlisted"
    | "forbidden-surface"
    | "missing-gates";
  missingGates: AcpxMutatingWrapperGate[];
  activeForbiddenSurfaces: AcpxMutatingWrapperForbiddenSurface[];
};

const REQUIRED_MUTATING_WRAPPER_GATES: readonly AcpxMutatingWrapperGate[] = [
  "operator-scope",
  "operator-confirmation",
  "plugin-admin-rpc-grant",
  "plugin-source-allowlist",
  "audit",
  "rate-limit",
  "gateway-token",
  "explicit-wrapper-enable",
];

const FORBIDDEN_MUTATING_WRAPPER_SURFACES: readonly AcpxMutatingWrapperForbiddenSurface[] = [
  "generic-gateway-dispatcher",
  "client-supplied-mcpServers",
  "cli-mcp",
  "untrusted-plugin-source",
  "bulk-enable-all-admin-rpcs",
];

const ACPX_MUTATING_WRAPPER_DESIGNS: readonly AcpxMutatingWrapperDesign[] = [
  {
    id: "fased_chat_inject_request",
    method: "chat.inject",
    status: "design-only",
    executionEnabled: false,
    description:
      "Future fixed wrapper for requesting an operator-approved chat injection into a scoped session.",
    requiredGates: REQUIRED_MUTATING_WRAPPER_GATES,
    forbiddenSurfaces: FORBIDDEN_MUTATING_WRAPPER_SURFACES,
  },
  {
    id: "fased_push_test_request",
    method: "push.test",
    status: "design-only",
    executionEnabled: false,
    description:
      "Future fixed wrapper for requesting an operator-approved test push to a scoped node.",
    requiredGates: REQUIRED_MUTATING_WRAPPER_GATES,
    forbiddenSurfaces: FORBIDDEN_MUTATING_WRAPPER_SURFACES,
  },
  {
    id: "fased_web_login_start_request",
    method: "web.login.start",
    status: "design-only",
    executionEnabled: false,
    description:
      "Future fixed wrapper for requesting an operator-approved web login start for a scoped account.",
    requiredGates: REQUIRED_MUTATING_WRAPPER_GATES,
    forbiddenSurfaces: FORBIDDEN_MUTATING_WRAPPER_SURFACES,
  },
  {
    id: "fased_web_login_wait_request",
    method: "web.login.wait",
    status: "design-only",
    executionEnabled: false,
    description:
      "Future fixed wrapper for requesting an operator-approved web login wait for a scoped account.",
    requiredGates: REQUIRED_MUTATING_WRAPPER_GATES,
    forbiddenSurfaces: FORBIDDEN_MUTATING_WRAPPER_SURFACES,
  },
];

export function listAcpxMutatingWrapperDesigns(): readonly AcpxMutatingWrapperDesign[] {
  return ACPX_MUTATING_WRAPPER_DESIGNS;
}

export function findAcpxMutatingWrapperDesign(id: string): AcpxMutatingWrapperDesign | undefined {
  return ACPX_MUTATING_WRAPPER_DESIGNS.find((design) => design.id === id);
}

export function isAcpxMutatingWrapperExecutionEnabled(id: string): boolean {
  return findAcpxMutatingWrapperDesign(id)?.executionEnabled === true;
}

function uniqueStrings(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim()).filter(Boolean));
}

export function evaluateAcpxMutatingWrapperRuntimeGate(
  input: AcpxMutatingWrapperRuntimeGateInput,
): AcpxMutatingWrapperRuntimeGateDecision {
  const wrapperId = input.wrapperId.trim();
  const design = findAcpxMutatingWrapperDesign(wrapperId);
  if (!design) {
    return {
      wrapperId,
      allowed: false,
      reason: "unknown-wrapper",
      missingGates: [],
      activeForbiddenSurfaces: [],
    };
  }

  const denyWrappers = uniqueStrings(input.denyWrappers);
  if (denyWrappers.has(design.id)) {
    return {
      wrapperId: design.id,
      method: design.method,
      allowed: false,
      reason: "denied-wrapper",
      missingGates: [],
      activeForbiddenSurfaces: [],
    };
  }

  const allowWrappers = uniqueStrings(input.allowWrappers);
  if (allowWrappers.size > 0 && !allowWrappers.has(design.id)) {
    return {
      wrapperId: design.id,
      method: design.method,
      allowed: false,
      reason: "not-allowlisted",
      missingGates: [],
      activeForbiddenSurfaces: [],
    };
  }

  const activeForbiddenSurfaces = design.forbiddenSurfaces.filter(
    (surface) => input.forbiddenSurfaces?.[surface] === true,
  );
  if (activeForbiddenSurfaces.length > 0) {
    return {
      wrapperId: design.id,
      method: design.method,
      allowed: false,
      reason: "forbidden-surface",
      missingGates: [],
      activeForbiddenSurfaces,
    };
  }

  const missingGates = design.requiredGates.filter((gate) => input.gates?.[gate] !== true);
  if (missingGates.length > 0) {
    return {
      wrapperId: design.id,
      method: design.method,
      allowed: false,
      reason: "missing-gates",
      missingGates,
      activeForbiddenSurfaces: [],
    };
  }

  return {
    wrapperId: design.id,
    method: design.method,
    allowed: true,
    reason: "allowed",
    missingGates: [],
    activeForbiddenSurfaces: [],
  };
}

export function validateAcpxMutatingWrapperDesigns(): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const seenMethods = new Set<string>();
  for (const design of ACPX_MUTATING_WRAPPER_DESIGNS) {
    if (seenIds.has(design.id)) {
      issues.push(`duplicate wrapper id: ${design.id}`);
    }
    seenIds.add(design.id);

    if (seenMethods.has(design.method)) {
      issues.push(`duplicate wrapper method: ${design.method}`);
    }
    seenMethods.add(design.method);

    const method = design.method as string;
    if (!isMutatingAdminRpcRateLimitedMethod(method)) {
      issues.push(`wrapper method is not rate-limited: ${method}`);
    }
    for (const gate of REQUIRED_MUTATING_WRAPPER_GATES) {
      if (!design.requiredGates.includes(gate)) {
        issues.push(`wrapper ${design.id} missing gate: ${gate}`);
      }
    }
    for (const surface of FORBIDDEN_MUTATING_WRAPPER_SURFACES) {
      if (!design.forbiddenSurfaces.includes(surface)) {
        issues.push(`wrapper ${design.id} missing forbidden surface: ${surface}`);
      }
    }
    if (design.executionEnabled || design.status !== "design-only") {
      issues.push(`wrapper ${design.id} must stay design-only until a runtime executor lands`);
    }
  }
  return issues;
}
