import AjvPkg, { type ErrorObject } from "ajv";
import type { SessionsPatchResult } from "../session-utils.types.js";
import {
  type AgentEvent,
  AgentEventSchema,
  type AgentIdentityParams,
  AgentIdentityParamsSchema,
  type AgentIdentityResult,
  AgentIdentityResultSchema,
  AgentParamsSchema,
  type AgentSummary,
  AgentSummarySchema,
  type AgentsFileEntry,
  AgentsFileEntrySchema,
  type AgentsCreateParams,
  AgentsCreateParamsSchema,
  type AgentsCreateResult,
  AgentsCreateResultSchema,
  type AgentsUpdateParams,
  AgentsUpdateParamsSchema,
  type AgentsUpdateResult,
  AgentsUpdateResultSchema,
  type AgentsDeleteParams,
  AgentsDeleteParamsSchema,
  type AgentsDeleteResult,
  AgentsDeleteResultSchema,
  type AgentsFilesGetParams,
  AgentsFilesGetParamsSchema,
  type AgentsFilesGetResult,
  AgentsFilesGetResultSchema,
  type AgentsFilesListParams,
  AgentsFilesListParamsSchema,
  type AgentsFilesListResult,
  AgentsFilesListResultSchema,
  type AgentsFilesSetParams,
  AgentsFilesSetParamsSchema,
  type AgentsFilesSetResult,
  AgentsFilesSetResultSchema,
  type AgentsListParams,
  AgentsListParamsSchema,
  type AgentsListResult,
  AgentsListResultSchema,
  type AgentWaitParams,
  AgentWaitParamsSchema,
  type ChannelsLogoutParams,
  ChannelsLogoutParamsSchema,
  type ChannelsRuntimeControlParams,
  ChannelsRuntimeControlParamsSchema,
  type ChannelsRuntimeControlResult,
  ChannelsRuntimeControlResultSchema,
  type TalkConfigParams,
  TalkConfigParamsSchema,
  type TalkConfigResult,
  TalkConfigResultSchema,
  type ChannelsStatusParams,
  ChannelsStatusParamsSchema,
  type ChannelsStatusResult,
  ChannelsStatusResultSchema,
  type ChatAbortParams,
  ChatAbortParamsSchema,
  type ChatEvent,
  ChatEventSchema,
  ChatHistoryParamsSchema,
  type ChatInjectParams,
  ChatInjectParamsSchema,
  ChatSendParamsSchema,
  type CommandArg,
  CommandArgSchema,
  type CommandArgChoice,
  CommandArgChoiceSchema,
  type CommandCategory,
  CommandCategorySchema,
  type CommandEntry,
  CommandEntrySchema,
  type CommandsListParams,
  CommandsListParamsSchema,
  type CommandsListResult,
  CommandsListResultSchema,
  type CommandScope,
  CommandScopeSchema,
  type CommandSource,
  CommandSourceSchema,
  type ConfigApplyParams,
  ConfigApplyParamsSchema,
  type ConfigGetParams,
  ConfigGetParamsSchema,
  type ConfigPatchParams,
  ConfigPatchParamsSchema,
  type ConfigSchemaLookupParams,
  ConfigSchemaLookupParamsSchema,
  type ConfigSchemaLookupResult,
  ConfigSchemaLookupResultSchema,
  type ConfigSchemaParams,
  ConfigSchemaParamsSchema,
  type ConfigSchemaResponse,
  ConfigSchemaResponseSchema,
  type ConfigSetParams,
  ConfigSetParamsSchema,
  type ConnectParams,
  ConnectParamsSchema,
  type CronAddParams,
  CronAddParamsSchema,
  type CronJob,
  CronJobSchema,
  type CronListParams,
  CronListParamsSchema,
  type CronQueueControlParams,
  CronQueueControlParamsSchema,
  type CronRepairParams,
  CronRepairParamsSchema,
  type CronRemoveParams,
  CronRemoveParamsSchema,
  type CronRunDetailParams,
  CronRunDetailParamsSchema,
  type CronRunLogEntry,
  type CronRunParams,
  CronRunParamsSchema,
  type CronRunsParams,
  CronRunsParamsSchema,
  type CronStatusParams,
  CronStatusParamsSchema,
  CronSourcesListParamsSchema,
  CronSourcesRemoveParamsSchema,
  CronSourcesUpdateParamsSchema,
  type CronUpdateParams,
  CronUpdateParamsSchema,
  type DevicePairApproveParams,
  DevicePairApproveParamsSchema,
  type DevicePairListParams,
  DevicePairListParamsSchema,
  type DevicePairRemoveParams,
  DevicePairRemoveParamsSchema,
  type DevicePairRejectParams,
  DevicePairRejectParamsSchema,
  type DeviceTokenRevokeParams,
  DeviceTokenRevokeParamsSchema,
  type DeviceTokenRotateParams,
  DeviceTokenRotateParamsSchema,
  type ExecApprovalsGetParams,
  ExecApprovalsGetParamsSchema,
  type ExecApprovalsNodeGetParams,
  ExecApprovalsNodeGetParamsSchema,
  type ExecApprovalsNodeSetParams,
  ExecApprovalsNodeSetParamsSchema,
  type ExecApprovalsSetParams,
  ExecApprovalsSetParamsSchema,
  type ExecApprovalsSnapshot,
  type ExecApprovalGetParams,
  ExecApprovalGetParamsSchema,
  type ExecApprovalListParams,
  ExecApprovalListParamsSchema,
  type ExecApprovalRequestParams,
  ExecApprovalRequestParamsSchema,
  type ExecApprovalResolveParams,
  ExecApprovalResolveParamsSchema,
  ErrorCodes,
  type ErrorShape,
  type ErrorCode,
  ErrorShapeSchema,
  type EventFrame,
  EventFrameSchema,
  errorShape,
  type GatewayFrame,
  GatewayFrameSchema,
  type HelloOk,
  HelloOkSchema,
  type LogsTailParams,
  LogsTailParamsSchema,
  type LogsTailResult,
  LogsTailResultSchema,
  type ModelsAuthClearParams,
  ModelsAuthClearParamsSchema,
  type ModelsAuthConfigureParams,
  ModelsAuthConfigureParamsSchema,
  type ModelsAuthInteractiveStartParams,
  ModelsAuthInteractiveStartParamsSchema,
  type ModelsAuthStatusParams,
  ModelsAuthStatusParamsSchema,
  type ModelsAuthStoreParams,
  ModelsAuthStoreParamsSchema,
  type ModelsCatalogStatusParams,
  ModelsCatalogStatusParamsSchema,
  type ModelsListParams,
  ModelsListParamsSchema,
  type PluginsMarketplaceInfoParams,
  PluginsMarketplaceInfoParamsSchema,
  type PluginsMarketplaceAdminRpcGrantSetParams,
  PluginsMarketplaceAdminRpcGrantSetParamsSchema,
  type PluginsMarketplaceInstallParams,
  PluginsMarketplaceInstallParamsSchema,
  type PluginsMarketplaceListParams,
  PluginsMarketplaceListParamsSchema,
  type PluginsMarketplaceRestartParams,
  PluginsMarketplaceRestartParamsSchema,
  type PluginsMarketplaceRuntimeHelperSetParams,
  PluginsMarketplaceRuntimeHelperSetParamsSchema,
  type PluginsMarketplaceUninstallParams,
  PluginsMarketplaceUninstallParamsSchema,
  type PluginsMarketplaceUpdatePreviewParams,
  PluginsMarketplaceUpdatePreviewParamsSchema,
  type PluginsMarketplaceUpdateParams,
  PluginsMarketplaceUpdateParamsSchema,
  type NodeDescribeParams,
  NodeDescribeParamsSchema,
  type NodeEventParams,
  NodeEventParamsSchema,
  type NodeInvokeParams,
  NodeInvokeParamsSchema,
  type NodeInvokeResultParams,
  NodeInvokeResultParamsSchema,
  type NodeListParams,
  NodeListParamsSchema,
  type NodePendingAckParams,
  NodePendingAckParamsSchema,
  type NodePendingDrainParams,
  NodePendingDrainParamsSchema,
  type NodePendingEnqueueParams,
  NodePendingEnqueueParamsSchema,
  type NodePendingPullParams,
  NodePendingPullParamsSchema,
  type NodePairApproveParams,
  NodePairApproveParamsSchema,
  type NodePairListParams,
  NodePairListParamsSchema,
  type NodePairRejectParams,
  NodePairRejectParamsSchema,
  type NodePairRemoveParams,
  NodePairRemoveParamsSchema,
  type NodePairRequestParams,
  NodePairRequestParamsSchema,
  type NodePairVerifyParams,
  NodePairVerifyParamsSchema,
  type NodeRenameParams,
  NodeRenameParamsSchema,
  type PollParams,
  PollParamsSchema,
  PROTOCOL_VERSION,
  type PushTestParams,
  PushTestParamsSchema,
  PushTestResultSchema,
  type PresenceEntry,
  PresenceEntrySchema,
  ProtocolSchemas,
  type RequestFrame,
  RequestFrameSchema,
  type ResponseFrame,
  ResponseFrameSchema,
  SendParamsSchema,
  type SessionsCompactParams,
  SessionsCompactParamsSchema,
  type SessionsCompactionBranchParams,
  SessionsCompactionBranchParamsSchema,
  type SessionsCompactionGetParams,
  SessionsCompactionGetParamsSchema,
  type SessionsCompactionListParams,
  SessionsCompactionListParamsSchema,
  type SessionsCompactionRestoreParams,
  SessionsCompactionRestoreParamsSchema,
  type SessionsDeleteParams,
  SessionsDeleteParamsSchema,
  type SessionsListParams,
  SessionsListParamsSchema,
  type SessionsMessagesSubscribeParams,
  SessionsMessagesSubscribeParamsSchema,
  type SessionsMessagesUnsubscribeParams,
  SessionsMessagesUnsubscribeParamsSchema,
  type SessionsPatchParams,
  SessionsPatchParamsSchema,
  type SessionsPreviewParams,
  SessionsPreviewParamsSchema,
  type SessionsResetParams,
  SessionsResetParamsSchema,
  type SessionsResolveParams,
  SessionsResolveParamsSchema,
  type SessionsUsageParams,
  SessionsUsageParamsSchema,
  type ShutdownEvent,
  ShutdownEventSchema,
  type SkillsBinsParams,
  SkillsBinsParamsSchema,
  type SkillsBinsResult,
  type SkillsCopyParams,
  SkillsCopyParamsSchema,
  SkillsCopyResultSchema,
  type SkillsCreateParams,
  SkillsCreateParamsSchema,
  type SkillsCreateResult,
  SkillsCreateResultSchema,
  type SkillsDetailParams,
  SkillsDetailParamsSchema,
  type SkillsDetailResult,
  SkillsDetailResultSchema,
  type SkillsFileGetParams,
  SkillsFileGetParamsSchema,
  type SkillsFileGetResult,
  SkillsFileGetResultSchema,
  type SkillsFileSetParams,
  SkillsFileSetParamsSchema,
  type SkillsFileSetResult,
  SkillsFileSetResultSchema,
  type SkillsInstallParams,
  SkillsInstallParamsSchema,
  type SkillsMarketplaceInstallPreviewParams,
  SkillsMarketplaceInstallPreviewParamsSchema,
  type SkillsMarketplaceInstallPreviewResult,
  SkillsMarketplaceInstallPreviewResultSchema,
  type SkillsMarketplaceInstallParams,
  SkillsMarketplaceInstallParamsSchema,
  type SkillsMarketplaceInstallResult,
  SkillsMarketplaceInstallResultSchema,
  type SkillsMarketplaceUpdateParams,
  SkillsMarketplaceUpdateParamsSchema,
  type SkillsMarketplaceUpdatePreviewParams,
  SkillsMarketplaceUpdatePreviewParamsSchema,
  type SkillsMarketplaceUpdatePreviewResult,
  SkillsMarketplaceUpdatePreviewResultSchema,
  type SkillsMarketplaceUpdateResult,
  SkillsMarketplaceUpdateResultSchema,
  type SkillsWalletGrantClearParams,
  SkillsWalletGrantClearParamsSchema,
  type SkillsWalletGrantClearResult,
  SkillsWalletGrantClearResultSchema,
  type SkillsWalletGrantsParams,
  SkillsWalletGrantsParamsSchema,
  type SkillsWalletGrantsResult,
  SkillsWalletGrantsResultSchema,
  type SkillsWalletGrantSetParams,
  SkillsWalletGrantSetParamsSchema,
  type SkillsWalletGrantSetResult,
  SkillsWalletGrantSetResultSchema,
  type SkillsSearchParams,
  SkillsSearchParamsSchema,
  type SkillsSearchResult,
  SkillsSearchResultSchema,
  type SkillsStatusParams,
  SkillsStatusParamsSchema,
  type SkillsUpdateParams,
  SkillsUpdateParamsSchema,
  type ToolsCatalogParams,
  ToolsCatalogParamsSchema,
  type ToolsCatalogResult,
  type ToolsEffectiveParams,
  ToolsEffectiveParamsSchema,
  type ToolsEffectiveResult,
  type Snapshot,
  SnapshotSchema,
  type StateVersion,
  StateVersionSchema,
  type TalkModeParams,
  TalkModeParamsSchema,
  type TickEvent,
  TickEventSchema,
  type UpdateRunParams,
  UpdateRunParamsSchema,
  type UpdateStatusParams,
  UpdateStatusParamsSchema,
  type WakeParams,
  WakeParamsSchema,
  type WebLoginStartParams,
  WebLoginStartParamsSchema,
  type WebLoginWaitParams,
  WebLoginWaitParamsSchema,
  type WizardCancelParams,
  WizardCancelParamsSchema,
  type WizardNextParams,
  WizardNextParamsSchema,
  type WizardNextResult,
  WizardNextResultSchema,
  type WizardStartParams,
  WizardStartParamsSchema,
  type WizardStartResult,
  WizardStartResultSchema,
  type WizardStatusParams,
  WizardStatusParamsSchema,
  type WizardStatusResult,
  WizardStatusResultSchema,
  type WizardStep,
  WizardStepSchema,
} from "./schema.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateConnectParams = ajv.compile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame = ajv.compile<RequestFrame>(RequestFrameSchema);
export const validateResponseFrame = ajv.compile<ResponseFrame>(ResponseFrameSchema);
export const validateEventFrame = ajv.compile<EventFrame>(EventFrameSchema);
export const validateSendParams = ajv.compile(SendParamsSchema);
export const validatePollParams = ajv.compile<PollParams>(PollParamsSchema);
export const validateAgentParams = ajv.compile(AgentParamsSchema);
export const validateAgentIdentityParams =
  ajv.compile<AgentIdentityParams>(AgentIdentityParamsSchema);
export const validateAgentWaitParams = ajv.compile<AgentWaitParams>(AgentWaitParamsSchema);
export const validateWakeParams = ajv.compile<WakeParams>(WakeParamsSchema);
export const validateAgentsListParams = ajv.compile<AgentsListParams>(AgentsListParamsSchema);
export const validateAgentsCreateParams = ajv.compile<AgentsCreateParams>(AgentsCreateParamsSchema);
export const validateAgentsUpdateParams = ajv.compile<AgentsUpdateParams>(AgentsUpdateParamsSchema);
export const validateAgentsDeleteParams = ajv.compile<AgentsDeleteParams>(AgentsDeleteParamsSchema);
export const validateAgentsFilesListParams = ajv.compile<AgentsFilesListParams>(
  AgentsFilesListParamsSchema,
);
export const validateAgentsFilesGetParams = ajv.compile<AgentsFilesGetParams>(
  AgentsFilesGetParamsSchema,
);
export const validateAgentsFilesSetParams = ajv.compile<AgentsFilesSetParams>(
  AgentsFilesSetParamsSchema,
);
export const validateCommandsListParams = ajv.compile<CommandsListParams>(CommandsListParamsSchema);
export const validateNodePairRequestParams = ajv.compile<NodePairRequestParams>(
  NodePairRequestParamsSchema,
);
export const validateNodePairListParams = ajv.compile<NodePairListParams>(NodePairListParamsSchema);
export const validateNodePairApproveParams = ajv.compile<NodePairApproveParams>(
  NodePairApproveParamsSchema,
);
export const validateNodePairRejectParams = ajv.compile<NodePairRejectParams>(
  NodePairRejectParamsSchema,
);
export const validateNodePairRemoveParams = ajv.compile<NodePairRemoveParams>(
  NodePairRemoveParamsSchema,
);
export const validateNodePairVerifyParams = ajv.compile<NodePairVerifyParams>(
  NodePairVerifyParamsSchema,
);
export const validateNodeRenameParams = ajv.compile<NodeRenameParams>(NodeRenameParamsSchema);
export const validateNodeListParams = ajv.compile<NodeListParams>(NodeListParamsSchema);
export const validateNodeDescribeParams = ajv.compile<NodeDescribeParams>(NodeDescribeParamsSchema);
export const validateNodePendingDrainParams = ajv.compile<NodePendingDrainParams>(
  NodePendingDrainParamsSchema,
);
export const validateNodePendingPullParams = ajv.compile<NodePendingPullParams>(
  NodePendingPullParamsSchema,
);
export const validateNodePendingAckParams = ajv.compile<NodePendingAckParams>(
  NodePendingAckParamsSchema,
);
export const validateNodePendingEnqueueParams = ajv.compile<NodePendingEnqueueParams>(
  NodePendingEnqueueParamsSchema,
);
export const validateNodeInvokeParams = ajv.compile<NodeInvokeParams>(NodeInvokeParamsSchema);
export const validateNodeInvokeResultParams = ajv.compile<NodeInvokeResultParams>(
  NodeInvokeResultParamsSchema,
);
export const validateNodeEventParams = ajv.compile<NodeEventParams>(NodeEventParamsSchema);
export const validatePushTestParams = ajv.compile<PushTestParams>(PushTestParamsSchema);
export const validateSessionsListParams = ajv.compile<SessionsListParams>(SessionsListParamsSchema);
export const validateSessionsMessagesSubscribeParams = ajv.compile<SessionsMessagesSubscribeParams>(
  SessionsMessagesSubscribeParamsSchema,
);
export const validateSessionsMessagesUnsubscribeParams =
  ajv.compile<SessionsMessagesUnsubscribeParams>(SessionsMessagesUnsubscribeParamsSchema);
export const validateSessionsPreviewParams = ajv.compile<SessionsPreviewParams>(
  SessionsPreviewParamsSchema,
);
export const validateSessionsResolveParams = ajv.compile<SessionsResolveParams>(
  SessionsResolveParamsSchema,
);
export const validateSessionsPatchParams =
  ajv.compile<SessionsPatchParams>(SessionsPatchParamsSchema);
export const validateSessionsResetParams =
  ajv.compile<SessionsResetParams>(SessionsResetParamsSchema);
export const validateSessionsDeleteParams = ajv.compile<SessionsDeleteParams>(
  SessionsDeleteParamsSchema,
);
export const validateSessionsCompactParams = ajv.compile<SessionsCompactParams>(
  SessionsCompactParamsSchema,
);
export const validateSessionsCompactionListParams = ajv.compile<SessionsCompactionListParams>(
  SessionsCompactionListParamsSchema,
);
export const validateSessionsCompactionGetParams = ajv.compile<SessionsCompactionGetParams>(
  SessionsCompactionGetParamsSchema,
);
export const validateSessionsCompactionBranchParams = ajv.compile<SessionsCompactionBranchParams>(
  SessionsCompactionBranchParamsSchema,
);
export const validateSessionsCompactionRestoreParams = ajv.compile<SessionsCompactionRestoreParams>(
  SessionsCompactionRestoreParamsSchema,
);
export const validateSessionsUsageParams =
  ajv.compile<SessionsUsageParams>(SessionsUsageParamsSchema);
export const validateConfigGetParams = ajv.compile<ConfigGetParams>(ConfigGetParamsSchema);
export const validateConfigSetParams = ajv.compile<ConfigSetParams>(ConfigSetParamsSchema);
export const validateConfigApplyParams = ajv.compile<ConfigApplyParams>(ConfigApplyParamsSchema);
export const validateConfigPatchParams = ajv.compile<ConfigPatchParams>(ConfigPatchParamsSchema);
export const validateConfigSchemaParams = ajv.compile<ConfigSchemaParams>(ConfigSchemaParamsSchema);
export const validateConfigSchemaLookupParams = ajv.compile<ConfigSchemaLookupParams>(
  ConfigSchemaLookupParamsSchema,
);
export const validateConfigSchemaLookupResult = ajv.compile<ConfigSchemaLookupResult>(
  ConfigSchemaLookupResultSchema,
);
export const validateWizardStartParams = ajv.compile<WizardStartParams>(WizardStartParamsSchema);
export const validateWizardNextParams = ajv.compile<WizardNextParams>(WizardNextParamsSchema);
export const validateWizardCancelParams = ajv.compile<WizardCancelParams>(WizardCancelParamsSchema);
export const validateWizardStatusParams = ajv.compile<WizardStatusParams>(WizardStatusParamsSchema);
export const validateTalkModeParams = ajv.compile<TalkModeParams>(TalkModeParamsSchema);
export const validateTalkConfigParams = ajv.compile<TalkConfigParams>(TalkConfigParamsSchema);
export const validateChannelsStatusParams = ajv.compile<ChannelsStatusParams>(
  ChannelsStatusParamsSchema,
);
export const validateChannelsLogoutParams = ajv.compile<ChannelsLogoutParams>(
  ChannelsLogoutParamsSchema,
);
export const validateChannelsRuntimeControlParams = ajv.compile<ChannelsRuntimeControlParams>(
  ChannelsRuntimeControlParamsSchema,
);
export const validateModelsAuthInteractiveStartParams =
  ajv.compile<ModelsAuthInteractiveStartParams>(ModelsAuthInteractiveStartParamsSchema);
export const validateModelsAuthConfigureParams = ajv.compile<ModelsAuthConfigureParams>(
  ModelsAuthConfigureParamsSchema,
);
export const validateModelsAuthStoreParams = ajv.compile<ModelsAuthStoreParams>(
  ModelsAuthStoreParamsSchema,
);
export const validateModelsAuthClearParams = ajv.compile<ModelsAuthClearParams>(
  ModelsAuthClearParamsSchema,
);
export const validateModelsAuthStatusParams = ajv.compile<ModelsAuthStatusParams>(
  ModelsAuthStatusParamsSchema,
);
export const validateModelsCatalogStatusParams = ajv.compile<ModelsCatalogStatusParams>(
  ModelsCatalogStatusParamsSchema,
);
export const validateModelsListParams = ajv.compile<ModelsListParams>(ModelsListParamsSchema);
export const validatePluginsMarketplaceListParams = ajv.compile<PluginsMarketplaceListParams>(
  PluginsMarketplaceListParamsSchema,
);
export const validatePluginsMarketplaceInfoParams = ajv.compile<PluginsMarketplaceInfoParams>(
  PluginsMarketplaceInfoParamsSchema,
);
export const validatePluginsMarketplaceAdminRpcGrantSetParams =
  ajv.compile<PluginsMarketplaceAdminRpcGrantSetParams>(
    PluginsMarketplaceAdminRpcGrantSetParamsSchema,
  );
export const validatePluginsMarketplaceInstallParams = ajv.compile<PluginsMarketplaceInstallParams>(
  PluginsMarketplaceInstallParamsSchema,
);
export const validatePluginsMarketplaceRestartParams = ajv.compile<PluginsMarketplaceRestartParams>(
  PluginsMarketplaceRestartParamsSchema,
);
export const validatePluginsMarketplaceRuntimeHelperSetParams =
  ajv.compile<PluginsMarketplaceRuntimeHelperSetParams>(
    PluginsMarketplaceRuntimeHelperSetParamsSchema,
  );
export const validatePluginsMarketplaceUpdateParams = ajv.compile<PluginsMarketplaceUpdateParams>(
  PluginsMarketplaceUpdateParamsSchema,
);
export const validatePluginsMarketplaceUpdatePreviewParams =
  ajv.compile<PluginsMarketplaceUpdatePreviewParams>(PluginsMarketplaceUpdatePreviewParamsSchema);
export const validatePluginsMarketplaceUninstallParams =
  ajv.compile<PluginsMarketplaceUninstallParams>(PluginsMarketplaceUninstallParamsSchema);
export const validateSkillsStatusParams = ajv.compile<SkillsStatusParams>(SkillsStatusParamsSchema);
export const validateToolsCatalogParams = ajv.compile<ToolsCatalogParams>(ToolsCatalogParamsSchema);
export const validateToolsEffectiveParams = ajv.compile<ToolsEffectiveParams>(
  ToolsEffectiveParamsSchema,
);
export const validateSkillsBinsParams = ajv.compile<SkillsBinsParams>(SkillsBinsParamsSchema);
export const validateSkillsCopyParams = ajv.compile<SkillsCopyParams>(SkillsCopyParamsSchema);
export const validateSkillsCreateParams = ajv.compile<SkillsCreateParams>(SkillsCreateParamsSchema);
export const validateSkillsSearchParams = ajv.compile<SkillsSearchParams>(SkillsSearchParamsSchema);
export const validateSkillsDetailParams = ajv.compile<SkillsDetailParams>(SkillsDetailParamsSchema);
export const validateSkillsFileGetParams =
  ajv.compile<SkillsFileGetParams>(SkillsFileGetParamsSchema);
export const validateSkillsFileSetParams =
  ajv.compile<SkillsFileSetParams>(SkillsFileSetParamsSchema);
export const validateSkillsMarketplaceInstallPreviewParams =
  ajv.compile<SkillsMarketplaceInstallPreviewParams>(SkillsMarketplaceInstallPreviewParamsSchema);
export const validateSkillsMarketplaceInstallParams = ajv.compile<SkillsMarketplaceInstallParams>(
  SkillsMarketplaceInstallParamsSchema,
);
export const validateSkillsMarketplaceUpdatePreviewParams =
  ajv.compile<SkillsMarketplaceUpdatePreviewParams>(SkillsMarketplaceUpdatePreviewParamsSchema);
export const validateSkillsMarketplaceUpdateParams = ajv.compile<SkillsMarketplaceUpdateParams>(
  SkillsMarketplaceUpdateParamsSchema,
);
export const validateSkillsWalletGrantsParams = ajv.compile<SkillsWalletGrantsParams>(
  SkillsWalletGrantsParamsSchema,
);
export const validateSkillsWalletGrantSetParams = ajv.compile<SkillsWalletGrantSetParams>(
  SkillsWalletGrantSetParamsSchema,
);
export const validateSkillsWalletGrantClearParams = ajv.compile<SkillsWalletGrantClearParams>(
  SkillsWalletGrantClearParamsSchema,
);
export const validateSkillsInstallParams =
  ajv.compile<SkillsInstallParams>(SkillsInstallParamsSchema);
export const validateSkillsUpdateParams = ajv.compile<SkillsUpdateParams>(SkillsUpdateParamsSchema);
export const validateCronListParams = ajv.compile<CronListParams>(CronListParamsSchema);
export const validateCronStatusParams = ajv.compile<CronStatusParams>(CronStatusParamsSchema);
export const validateCronAddParams = ajv.compile<CronAddParams>(CronAddParamsSchema);
export const validateCronUpdateParams = ajv.compile<CronUpdateParams>(CronUpdateParamsSchema);
export const validateCronRepairParams = ajv.compile<CronRepairParams>(CronRepairParamsSchema);
export const validateCronSourcesListParams = ajv.compile(CronSourcesListParamsSchema);
export const validateCronSourcesUpdateParams = ajv.compile(CronSourcesUpdateParamsSchema);
export const validateCronSourcesRemoveParams = ajv.compile(CronSourcesRemoveParamsSchema);
export const validateCronRemoveParams = ajv.compile<CronRemoveParams>(CronRemoveParamsSchema);
export const validateCronQueueControlParams = ajv.compile<CronQueueControlParams>(
  CronQueueControlParamsSchema,
);
export const validateCronRunDetailParams =
  ajv.compile<CronRunDetailParams>(CronRunDetailParamsSchema);
export const validateCronRunParams = ajv.compile<CronRunParams>(CronRunParamsSchema);
export const validateCronRunsParams = ajv.compile<CronRunsParams>(CronRunsParamsSchema);
export const validateDevicePairListParams = ajv.compile<DevicePairListParams>(
  DevicePairListParamsSchema,
);
export const validateDevicePairApproveParams = ajv.compile<DevicePairApproveParams>(
  DevicePairApproveParamsSchema,
);
export const validateDevicePairRejectParams = ajv.compile<DevicePairRejectParams>(
  DevicePairRejectParamsSchema,
);
export const validateDevicePairRemoveParams = ajv.compile<DevicePairRemoveParams>(
  DevicePairRemoveParamsSchema,
);
export const validateDeviceTokenRotateParams = ajv.compile<DeviceTokenRotateParams>(
  DeviceTokenRotateParamsSchema,
);
export const validateDeviceTokenRevokeParams = ajv.compile<DeviceTokenRevokeParams>(
  DeviceTokenRevokeParamsSchema,
);
export const validateExecApprovalsGetParams = ajv.compile<ExecApprovalsGetParams>(
  ExecApprovalsGetParamsSchema,
);
export const validateExecApprovalsSetParams = ajv.compile<ExecApprovalsSetParams>(
  ExecApprovalsSetParamsSchema,
);
export const validateExecApprovalGetParams = ajv.compile<ExecApprovalGetParams>(
  ExecApprovalGetParamsSchema,
);
export const validateExecApprovalListParams = ajv.compile<ExecApprovalListParams>(
  ExecApprovalListParamsSchema,
);
export const validateExecApprovalRequestParams = ajv.compile<ExecApprovalRequestParams>(
  ExecApprovalRequestParamsSchema,
);
export const validateExecApprovalResolveParams = ajv.compile<ExecApprovalResolveParams>(
  ExecApprovalResolveParamsSchema,
);
export const validateExecApprovalsNodeGetParams = ajv.compile<ExecApprovalsNodeGetParams>(
  ExecApprovalsNodeGetParamsSchema,
);
export const validateExecApprovalsNodeSetParams = ajv.compile<ExecApprovalsNodeSetParams>(
  ExecApprovalsNodeSetParamsSchema,
);
export const validateLogsTailParams = ajv.compile<LogsTailParams>(LogsTailParamsSchema);
export const validateChatHistoryParams = ajv.compile(ChatHistoryParamsSchema);
export const validateChatSendParams = ajv.compile(ChatSendParamsSchema);
export const validateChatAbortParams = ajv.compile<ChatAbortParams>(ChatAbortParamsSchema);
export const validateChatInjectParams = ajv.compile<ChatInjectParams>(ChatInjectParamsSchema);
export const validateChatEvent = ajv.compile(ChatEventSchema);
export const validateUpdateRunParams = ajv.compile<UpdateRunParams>(UpdateRunParamsSchema);
export const validateUpdateStatusParams = ajv.compile<UpdateStatusParams>(UpdateStatusParamsSchema);
export const validateWebLoginStartParams =
  ajv.compile<WebLoginStartParams>(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = ajv.compile<WebLoginWaitParams>(WebLoginWaitParamsSchema);

export function formatValidationErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors?.length) {
    return "unknown validation error";
  }

  const parts: string[] = [];

  for (const err of errors) {
    const keyword = typeof err?.keyword === "string" ? err.keyword : "";
    const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";

    if (keyword === "additionalProperties") {
      const params = err?.params as { additionalProperty?: unknown } | undefined;
      const additionalProperty = params?.additionalProperty;
      if (typeof additionalProperty === "string" && additionalProperty.trim()) {
        const where = instancePath ? `at ${instancePath}` : "at root";
        parts.push(`${where}: unexpected property '${additionalProperty}'`);
        continue;
      }
    }

    const message =
      typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
    const where = instancePath ? `at ${instancePath}: ` : "";
    parts.push(`${where}${message}`);
  }

  // De-dupe while preserving order.
  const unique = Array.from(new Set(parts.filter((part) => part.trim())));
  if (!unique.length) {
    const fallback = ajv.errorsText(errors, { separator: "; " });
    return fallback || "unknown validation error";
  }
  return unique.join("; ");
}

export {
  ConnectParamsSchema,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  PresenceEntrySchema,
  SnapshotSchema,
  ErrorShapeSchema,
  StateVersionSchema,
  AgentEventSchema,
  ChatEventSchema,
  SendParamsSchema,
  PollParamsSchema,
  AgentParamsSchema,
  AgentIdentityParamsSchema,
  AgentIdentityResultSchema,
  WakeParamsSchema,
  PushTestParamsSchema,
  PushTestResultSchema,
  NodePairRequestParamsSchema,
  NodePairListParamsSchema,
  NodePairApproveParamsSchema,
  NodePairRejectParamsSchema,
  NodePairRemoveParamsSchema,
  NodePairVerifyParamsSchema,
  NodeListParamsSchema,
  NodePendingDrainParamsSchema,
  NodePendingPullParamsSchema,
  NodePendingAckParamsSchema,
  NodePendingEnqueueParamsSchema,
  NodeInvokeParamsSchema,
  SessionsListParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsPatchParamsSchema,
  SessionsResetParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsCompactParamsSchema,
  SessionsCompactionListParamsSchema,
  SessionsCompactionGetParamsSchema,
  SessionsCompactionBranchParamsSchema,
  SessionsCompactionRestoreParamsSchema,
  SessionsUsageParamsSchema,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  ConfigApplyParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaLookupParamsSchema,
  ConfigSchemaLookupResultSchema,
  ConfigSchemaResponseSchema,
  CommandSourceSchema,
  CommandScopeSchema,
  CommandCategorySchema,
  CommandArgChoiceSchema,
  CommandArgSchema,
  CommandEntrySchema,
  CommandsListParamsSchema,
  CommandsListResultSchema,
  WizardStartParamsSchema,
  WizardNextParamsSchema,
  WizardCancelParamsSchema,
  WizardStatusParamsSchema,
  WizardStepSchema,
  WizardNextResultSchema,
  WizardStartResultSchema,
  WizardStatusResultSchema,
  TalkConfigParamsSchema,
  TalkConfigResultSchema,
  ChannelsStatusParamsSchema,
  ChannelsStatusResultSchema,
  ChannelsLogoutParamsSchema,
  ChannelsRuntimeControlParamsSchema,
  ChannelsRuntimeControlResultSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
  AgentSummarySchema,
  AgentsFileEntrySchema,
  AgentsCreateParamsSchema,
  AgentsCreateResultSchema,
  AgentsUpdateParamsSchema,
  AgentsUpdateResultSchema,
  AgentsDeleteParamsSchema,
  AgentsDeleteResultSchema,
  AgentsFilesListParamsSchema,
  AgentsFilesListResultSchema,
  AgentsFilesGetParamsSchema,
  AgentsFilesGetResultSchema,
  AgentsFilesSetParamsSchema,
  AgentsFilesSetResultSchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  ModelsAuthInteractiveStartParamsSchema,
  ModelsAuthConfigureParamsSchema,
  ModelsAuthClearParamsSchema,
  ModelsAuthStatusParamsSchema,
  ModelsAuthStoreParamsSchema,
  ModelsListParamsSchema,
  PluginsMarketplaceInstallParamsSchema,
  PluginsMarketplaceRestartParamsSchema,
  PluginsMarketplaceRuntimeHelperSetParamsSchema,
  SkillsStatusParamsSchema,
  ToolsCatalogParamsSchema,
  ToolsEffectiveParamsSchema,
  SkillsCopyParamsSchema,
  SkillsCopyResultSchema,
  SkillsCreateParamsSchema,
  SkillsCreateResultSchema,
  SkillsSearchParamsSchema,
  SkillsSearchResultSchema,
  SkillsDetailParamsSchema,
  SkillsDetailResultSchema,
  SkillsFileGetParamsSchema,
  SkillsFileGetResultSchema,
  SkillsFileSetParamsSchema,
  SkillsFileSetResultSchema,
  SkillsMarketplaceInstallPreviewParamsSchema,
  SkillsMarketplaceInstallPreviewResultSchema,
  SkillsMarketplaceInstallParamsSchema,
  SkillsMarketplaceInstallResultSchema,
  SkillsMarketplaceUpdatePreviewParamsSchema,
  SkillsMarketplaceUpdatePreviewResultSchema,
  SkillsMarketplaceUpdateParamsSchema,
  SkillsMarketplaceUpdateResultSchema,
  SkillsWalletGrantClearParamsSchema,
  SkillsWalletGrantClearResultSchema,
  SkillsWalletGrantsParamsSchema,
  SkillsWalletGrantsResultSchema,
  SkillsWalletGrantSetParamsSchema,
  SkillsWalletGrantSetResultSchema,
  SkillsInstallParamsSchema,
  SkillsUpdateParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronStatusParamsSchema,
  CronAddParamsSchema,
  CronUpdateParamsSchema,
  CronRepairParamsSchema,
  CronRemoveParamsSchema,
  CronQueueControlParamsSchema,
  CronRunDetailParamsSchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  ChatInjectParamsSchema,
  UpdateRunParamsSchema,
  UpdateStatusParamsSchema,
  TickEventSchema,
  ShutdownEventSchema,
  ProtocolSchemas,
  PROTOCOL_VERSION,
  ErrorCodes,
  errorShape,
};

export type {
  GatewayFrame,
  ErrorCode,
  ConnectParams,
  HelloOk,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  PresenceEntry,
  Snapshot,
  ErrorShape,
  StateVersion,
  AgentEvent,
  AgentIdentityParams,
  AgentIdentityResult,
  AgentWaitParams,
  ChatEvent,
  TickEvent,
  ShutdownEvent,
  WakeParams,
  PushTestParams,
  NodePairRequestParams,
  NodePairListParams,
  NodePairApproveParams,
  DevicePairListParams,
  DevicePairApproveParams,
  DevicePairRejectParams,
  ConfigGetParams,
  ConfigSetParams,
  ConfigApplyParams,
  ConfigPatchParams,
  ConfigSchemaParams,
  ConfigSchemaLookupParams,
  ConfigSchemaLookupResult,
  ConfigSchemaResponse,
  CommandSource,
  CommandScope,
  CommandCategory,
  CommandArgChoice,
  CommandArg,
  CommandEntry,
  CommandsListParams,
  CommandsListResult,
  WizardStartParams,
  WizardNextParams,
  WizardCancelParams,
  WizardStatusParams,
  WizardStep,
  WizardNextResult,
  WizardStartResult,
  WizardStatusResult,
  TalkConfigParams,
  TalkConfigResult,
  TalkModeParams,
  ChannelsStatusParams,
  ChannelsStatusResult,
  ChannelsLogoutParams,
  ChannelsRuntimeControlParams,
  ChannelsRuntimeControlResult,
  WebLoginStartParams,
  WebLoginWaitParams,
  AgentSummary,
  AgentsFileEntry,
  AgentsCreateParams,
  AgentsCreateResult,
  AgentsUpdateParams,
  AgentsUpdateResult,
  AgentsDeleteParams,
  AgentsDeleteResult,
  AgentsFilesListParams,
  AgentsFilesListResult,
  AgentsFilesGetParams,
  AgentsFilesGetResult,
  AgentsFilesSetParams,
  AgentsFilesSetResult,
  AgentsListParams,
  AgentsListResult,
  PluginsMarketplaceInstallParams,
  PluginsMarketplaceRestartParams,
  PluginsMarketplaceRuntimeHelperSetParams,
  PluginsMarketplaceUpdateParams,
  PluginsMarketplaceUpdatePreviewParams,
  PluginsMarketplaceUninstallParams,
  SkillsStatusParams,
  ToolsCatalogParams,
  ToolsCatalogResult,
  ToolsEffectiveParams,
  ToolsEffectiveResult,
  SkillsBinsParams,
  SkillsBinsResult,
  SkillsCreateParams,
  SkillsCreateResult,
  SkillsSearchParams,
  SkillsSearchResult,
  SkillsDetailParams,
  SkillsDetailResult,
  SkillsFileGetParams,
  SkillsFileGetResult,
  SkillsFileSetParams,
  SkillsFileSetResult,
  SkillsMarketplaceInstallPreviewParams,
  SkillsMarketplaceInstallPreviewResult,
  SkillsMarketplaceInstallParams,
  SkillsMarketplaceInstallResult,
  SkillsMarketplaceUpdatePreviewParams,
  SkillsMarketplaceUpdatePreviewResult,
  SkillsMarketplaceUpdateParams,
  SkillsMarketplaceUpdateResult,
  SkillsWalletGrantClearParams,
  SkillsWalletGrantClearResult,
  SkillsWalletGrantsParams,
  SkillsWalletGrantsResult,
  SkillsWalletGrantSetParams,
  SkillsWalletGrantSetResult,
  SkillsInstallParams,
  SkillsUpdateParams,
  NodePairRejectParams,
  NodePairVerifyParams,
  NodeListParams,
  NodePendingDrainParams,
  NodePendingPullParams,
  NodePendingAckParams,
  NodePendingEnqueueParams,
  NodeInvokeParams,
  NodeInvokeResultParams,
  NodeEventParams,
  SessionsListParams,
  SessionsPreviewParams,
  SessionsResolveParams,
  SessionsPatchParams,
  SessionsPatchResult,
  SessionsResetParams,
  SessionsDeleteParams,
  SessionsCompactParams,
  SessionsCompactionListParams,
  SessionsCompactionGetParams,
  SessionsCompactionBranchParams,
  SessionsCompactionRestoreParams,
  SessionsUsageParams,
  CronJob,
  CronListParams,
  CronStatusParams,
  CronAddParams,
  CronUpdateParams,
  CronRepairParams,
  CronRemoveParams,
  CronRunDetailParams,
  CronRunParams,
  CronRunsParams,
  CronRunLogEntry,
  ExecApprovalsGetParams,
  ExecApprovalsSetParams,
  ExecApprovalsSnapshot,
  ExecApprovalGetParams,
  ExecApprovalListParams,
  LogsTailParams,
  LogsTailResult,
  PollParams,
  UpdateRunParams,
  UpdateStatusParams,
  ChatInjectParams,
};
