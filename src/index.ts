export { VERSION } from "./version.js";

export {
  CALL_TOOL,
  FIND_TOOL,
  READ_RESULT,
  SecureProjectionKernel,
  readResultToolDefinition,
  usesSecureProjection,
} from "./secure-projection.js";
export type { ProjectionInvoker } from "./secure-projection.js";
export { GuardProxy } from "./proxy.js";
export type { GuardProxyOptions, GuardSurface } from "./proxy.js";
export { ServerManager } from "./server-manager.js";
export type {
  ConnectedUpstreamLifecycle,
  FailedUpstreamLifecycle,
  ServerManagerStartReport,
  ServerManagerStopReport,
} from "./server-manager.js";
export { AuditLogger } from "./audit.js";
export type { AuditLoggerOptions } from "./audit.js";
export { PolicyPipeline } from "./policies/base.js";
export { WhitelistPolicy } from "./policies/whitelist.js";
export type { GuardConfig, ToolsConfig, UpstreamServer } from "./config-types.js";
export type { Policy, PolicyContext, PolicyResult } from "./types.js";
export { NativeToolAdapter } from "./native-tool-adapter.js";
export type { NativeDeliveryResult, NativeToolRoute } from "./native-tool-adapter.js";
export {
  ResultSecurityInspector,
  type ResultFindingKind,
  type ResultFindingSeverity,
  type ResultObligation,
  type ResultSecurityAssessment,
  type ResultSecurityFinding,
} from "./result-security.js";
