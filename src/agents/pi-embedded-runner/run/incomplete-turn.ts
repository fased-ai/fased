export function buildAttemptReplayMetadata(params: {
  toolMetas?: Array<{ toolName: string; meta?: string }>;
  didSendViaMessagingTool?: boolean;
  successfulCronAdds?: number;
}): Record<string, unknown> {
  return {
    toolMetas: params.toolMetas ?? [],
    didSendViaMessagingTool: params.didSendViaMessagingTool ?? false,
    successfulCronAdds: params.successfulCronAdds ?? 0,
  };
}
