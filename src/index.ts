export const VERSION = "0.1.0";

export {
  CALL_TOOL,
  FIND_TOOL,
  READ_RESULT,
  SecureProjectionKernel,
  usesSecureProjection,
} from "./secure-projection.js";
export type { ProjectionInvoker } from "./secure-projection.js";
export {
  ResultSecurityInspector,
  type ResultFindingKind,
  type ResultFindingSeverity,
  type ResultObligation,
  type ResultSecurityAssessment,
  type ResultSecurityFinding,
} from "./result-security.js";
