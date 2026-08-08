export { VERSION } from "./version.js";

export {
  CALL_TOOL,
  FIND_TOOL,
  READ_RESULT,
  SecureProjectionKernel,
  readResultToolDefinition,
} from "./secure-projection.js";
export type { ProjectionInvoker } from "./secure-projection.js";
export { GuardProxy } from "./proxy.js";
export type { GuardProxyOptions, GuardMode } from "./proxy.js";
export { GUARD_MODES } from "./modes.js";
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
export { verifyModeAcceptance } from "./mode-acceptance.js";
export type { ModeAcceptanceDependencies, ModeAcceptanceReport } from "./mode-acceptance.js";
export {
  ResultSecurityInspector,
  type ResultFindingKind,
  type ResultFindingSeverity,
  type ResultObligation,
  type ResultSecurityAssessment,
  type ResultSecurityFinding,
} from "./result-security.js";
