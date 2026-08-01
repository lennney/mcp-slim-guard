import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const TRANSACTION_DIRECTORY = ".mcp-slim-guard";
const TRANSACTION_RECORD = "install-transaction.json";

export type InstallationHost = "codex" | "claude-code";
export type InstallationTransactionState = "prepared" | "installed" | "rolled_back";

export interface InstallationSpec {
  projectRoot: string;
  host: InstallationHost;
  targetPath: string;
  content: string;
  validate: (content: string) => void;
}

export interface InstallationTransactionRecord {
  schemaVersion: 1;
  kind: "mcp-slim-guard/install-transaction";
  state: InstallationTransactionState;
  transactionId: string;
  host: InstallationHost;
  targetPath: string;
  recordPath: string;
  backupPath: string | null;
  beforeExisted: boolean;
  beforeSha256: string | null;
  afterSha256: string;
  createdAt: string;
  installedAt?: string;
  rolledBackAt?: string;
  failureType?: string;
}

export interface InstallationResult {
  record: InstallationTransactionRecord;
  validation: "passed";
}

export interface RollbackResult {
  record: InstallationTransactionRecord;
  status: "rolled_back" | "already_rolled_back";
}

export interface InstallationEvidence {
  host: InstallationHost | "unknown";
  rollback: "available" | "completed" | "unknown";
}

export class InstallationConflictError extends Error {
  readonly code = "transaction_conflict";

  constructor(message = "The target changed after Slim Guard installation; rollback refused.") {
    super(message);
    this.name = "InstallationConflictError";
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolvedProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function boundedTarget(projectRoot: string, targetPath: string): string {
  const root = resolvedProjectRoot(projectRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Installation target must stay inside the project root.");
  }
  return target;
}

function transactionDirectory(projectRoot: string): string {
  return path.join(resolvedProjectRoot(projectRoot), TRANSACTION_DIRECTORY);
}

function transactionRecordPath(projectRoot: string): string {
  return path.join(transactionDirectory(projectRoot), TRANSACTION_RECORD);
}

function boundedStatePath(projectRoot: string, candidatePath: string): string {
  const stateDirectory = transactionDirectory(projectRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(stateDirectory, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Installation transaction state path is invalid.");
  }
  return candidate;
}

function expectedTargetPath(projectRoot: string, host: InstallationHost): string {
  return path.join(resolvedProjectRoot(projectRoot), host === "codex" ? ".codex/config.toml" : ".mcp.json");
}

function ensureDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Installation state path is not a regular directory.");
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Installation state path is not a regular directory.");
  }
}

function ensureTargetParent(targetPath: string): void {
  const parent = path.dirname(targetPath);
  ensureDirectory(parent);
}

function inspectRegularFile(filePath: string): { exists: boolean; bytes: Buffer } {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error("Installation target must not be a symbolic link.");
    if (!stat.isFile()) throw new Error("Installation target must be a regular file.");
    const bytes = fs.readFileSync(filePath);
    return { exists: true, bytes };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, bytes: Buffer.alloc(0) };
    }
    throw error;
  }
}

function currentHash(targetPath: string): string | null {
  const inspected = inspectRegularFile(targetPath);
  return inspected.exists ? sha256(inspected.bytes) : null;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write/rename error.
      }
    }
  }
}

function writeTargetAtomically(targetPath: string, content: string): void {
  ensureTargetParent(targetPath);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, "utf8");
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write/rename error.
      }
    }
  }
}

function copyBackupAtomically(backupPath: string, targetPath: string): void {
  ensureTargetParent(targetPath);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(backupPath, temporaryPath);
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write/rename error.
      }
    }
  }
}

function readRecord(projectRoot: string): InstallationTransactionRecord {
  const recordPath = transactionRecordPath(projectRoot);
  const inspected = inspectRegularFile(recordPath);
  if (!inspected.exists) throw new Error("No Slim Guard installation transaction found.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.bytes.toString("utf8"));
  } catch {
    throw new Error("Slim Guard installation transaction is invalid.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Slim Guard installation transaction is invalid.");
  const record = parsed as Partial<InstallationTransactionRecord>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "mcp-slim-guard/install-transaction" ||
    (record.state !== "prepared" && record.state !== "installed" && record.state !== "rolled_back") ||
    (record.host !== "codex" && record.host !== "claude-code") ||
    typeof record.targetPath !== "string" ||
    typeof record.recordPath !== "string" ||
    typeof record.transactionId !== "string" ||
    typeof record.afterSha256 !== "string" ||
    typeof record.beforeExisted !== "boolean" ||
    (record.beforeSha256 !== null && typeof record.beforeSha256 !== "string") ||
    (record.backupPath !== null && typeof record.backupPath !== "string")
  ) {
    throw new Error("Slim Guard installation transaction is invalid.");
  }
  if (path.resolve(record.recordPath) !== recordPath) {
    throw new Error("Slim Guard installation transaction record path is invalid.");
  }
  if (record.backupPath !== null) boundedStatePath(projectRoot, record.backupPath);
  return record as InstallationTransactionRecord;
}

function assertRecordTarget(projectRoot: string, record: InstallationTransactionRecord): string {
  const targetPath = boundedTarget(projectRoot, record.targetPath);
  if (targetPath !== expectedTargetPath(projectRoot, record.host)) {
    throw new Error("Installation transaction target is invalid.");
  }
  return targetPath;
}

function restoreBefore(record: InstallationTransactionRecord, projectRoot: string): void {
  const targetPath = assertRecordTarget(projectRoot, record);
  const observedHash = currentHash(targetPath);
  if (observedHash !== record.afterSha256) throw new InstallationConflictError();

  if (record.beforeExisted) {
    if (!record.backupPath) throw new Error("Installation backup is missing.");
    const backupPath = boundedStatePath(projectRoot, record.backupPath);
    const backup = inspectRegularFile(backupPath);
    if (!backup.exists || record.beforeSha256 === null || sha256(backup.bytes) !== record.beforeSha256) {
      throw new Error("Installation backup changed or is missing; rollback refused.");
    }
    copyBackupAtomically(backupPath, targetPath);
    if (currentHash(targetPath) !== record.beforeSha256) {
      throw new Error("Rollback validation failed.");
    }
  } else {
    fs.unlinkSync(targetPath);
    if (currentHash(targetPath) !== null) throw new Error("Rollback validation failed.");
  }
}

function writeRecord(record: InstallationTransactionRecord): void {
  writeJsonAtomically(record.recordPath, record);
}

export function installTransaction(spec: InstallationSpec): InstallationResult {
  spec.validate(spec.content);
  const root = resolvedProjectRoot(spec.projectRoot);
  const targetPath = boundedTarget(root, spec.targetPath);
  const recordPath = transactionRecordPath(root);
  ensureDirectory(transactionDirectory(root));

  const existingRecord = fs.existsSync(recordPath) ? readRecord(root) : undefined;
  if (existingRecord && existingRecord.state !== "rolled_back") {
    throw new Error("An active Slim Guard installation transaction already exists; rollback it first.");
  }

  const target = inspectRegularFile(targetPath);
  const beforeSha256 = target.exists ? sha256(target.bytes) : null;
  const transactionId = randomUUID();
  const backupPath = target.exists ? path.join(transactionDirectory(root), `${transactionId}.before`) : null;
  if (backupPath) {
    fs.copyFileSync(targetPath, backupPath);
    const backup = inspectRegularFile(backupPath);
    if (!backup.exists || sha256(backup.bytes) !== beforeSha256) {
      throw new Error("Installation backup validation failed.");
    }
  }

  const afterSha256 = sha256(Buffer.from(spec.content, "utf8"));
  const prepared: InstallationTransactionRecord = {
    schemaVersion: 1,
    kind: "mcp-slim-guard/install-transaction",
    state: "prepared",
    transactionId,
    host: spec.host,
    targetPath,
    recordPath,
    backupPath,
    beforeExisted: target.exists,
    beforeSha256,
    afterSha256,
    createdAt: new Date().toISOString(),
  };
  writeRecord(prepared);

  try {
    writeTargetAtomically(targetPath, spec.content);
    const written = inspectRegularFile(targetPath);
    const writtenContent = written.bytes.toString("utf8");
    spec.validate(writtenContent);
    if (!written.exists || sha256(written.bytes) !== afterSha256) {
      throw new Error("Installation validation failed.");
    }
    const installed: InstallationTransactionRecord = {
      ...prepared,
      state: "installed",
      installedAt: new Date().toISOString(),
    };
    writeRecord(installed);
    return { record: installed, validation: "passed" };
  } catch (error) {
    try {
      restoreBefore(prepared, root);
      writeRecord({
        ...prepared,
        state: "rolled_back",
        rolledBackAt: new Date().toISOString(),
        failureType: error instanceof Error ? error.name : "UnknownError",
      });
    } catch {
      // Keep the prepared record and backup so a later explicit rollback can
      // inspect the same transaction instead of overwriting user changes.
    }
    throw error;
  }
}

export function rollbackTransaction(projectRoot: string, expectedHost?: InstallationHost): RollbackResult {
  const root = resolvedProjectRoot(projectRoot);
  const record = readRecord(root);
  if (expectedHost && record.host !== expectedHost) {
    throw new Error(`The recorded transaction belongs to ${record.host}, not ${expectedHost}.`);
  }
  if (record.state === "rolled_back") return { record, status: "already_rolled_back" };

  restoreBefore(record, root);
  const rolledBack: InstallationTransactionRecord = {
    ...record,
    state: "rolled_back",
    rolledBackAt: new Date().toISOString(),
  };
  writeRecord(rolledBack);
  return { record: rolledBack, status: "rolled_back" };
}

export function installationTransactionPath(projectRoot: string): string {
  return transactionRecordPath(projectRoot);
}

/**
 * Read the small, privacy-safe part of the installation transaction that can
 * appear in a share report. Invalid, absent, or legacy state is deliberately
 * treated as unknown instead of exposing transaction details.
 */
export function readInstallationEvidence(projectRoot: string): InstallationEvidence {
  try {
    const record = readRecord(projectRoot);
    assertRecordTarget(projectRoot, record);
    return {
      host: record.host,
      rollback: record.state === "rolled_back" ? "completed" : "available",
    };
  } catch {
    return { host: "unknown", rollback: "unknown" };
  }
}
