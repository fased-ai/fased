#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const NORMALIZATION_SCHEMA_VERSION = 1;
const OPAQUE_CONTROL_RECORD = Symbol("opaque-control-record");

const CONTROL_RECORDS = Object.freeze([
  Object.freeze({
    key: "operatorJournal",
    relativeTo: "operator",
    path: "hosted-update-transaction.json",
    supportedSchemas: Object.freeze([1]),
    legacySignal: true,
  }),
  Object.freeze({
    key: "adoptionReceipt",
    relativeTo: "operator",
    path: "legacy-managed-update-adoption.v1.json",
    supportedSchemas: Object.freeze([1]),
    legacySignal: true,
  }),
  Object.freeze({
    key: "controllerHint",
    relativeTo: "operator",
    path: "protected-local-controller-transaction.json",
    supportedSchemas: Object.freeze([1]),
    legacySignal: false,
  }),
  Object.freeze({
    key: "legacyControllerSelection",
    relativeTo: "controller",
    path: "controller-version.json",
    supportedSchemas: Object.freeze([1, 2]),
    legacySignal: false,
  }),
  Object.freeze({
    key: "controllerSelection",
    relativeTo: "supervisor",
    path: "controller-version.json",
    supportedSchemas: Object.freeze([1, 2]),
    legacySignal: false,
  }),
  Object.freeze({
    key: "supervisorTransaction",
    relativeTo: "supervisor",
    path: "controller-transaction.json",
    supportedSchemas: Object.freeze([1, 2]),
    legacySignal: false,
  }),
  Object.freeze({
    key: "rootProductTransaction",
    relativeTo: "supervisor",
    path: "product-transaction.json",
    supportedSchemas: Object.freeze([1, 2, 3]),
    legacySignal: false,
  }),
  Object.freeze({
    key: "rootAdoptionReceipt",
    relativeTo: "supervisor",
    path: "legacy-managed-update-adoption.v1.json",
    supportedSchemas: Object.freeze([1]),
    legacySignal: false,
  }),
  Object.freeze({
    key: "controllerProductJournal",
    relativeTo: "controller",
    path: "active-signer-transaction.json",
    supportedSchemas: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
    legacySignal: false,
  }),
]);

function fail(message) {
  throw new Error(`lifecycle control normalization: ${message}`);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function protectedLocalNormalizationTransactionId(
  instanceId,
  previousVersion,
  targetVersion,
) {
  const source = `${String(instanceId ?? "")}\u0000${previousVersion}\u0000${targetVersion}`;
  const value = crypto.createHash("sha256").update(source).digest("hex").slice(0, 32).split("");
  value[12] = "4";
  value[16] = "8";
  const joined = value.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("canonical value contains an unsafe number");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  fail("canonical value contains an unsupported type");
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is invalid`);
  }
  const actual = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  const expected = [...keys].toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unexpected fields`);
  }
}

function validateOptions(options) {
  for (const name of ["operatorStateDir", "controllerStateDir", "supervisorStateDir"]) {
    if (!path.isAbsolute(options[name] ?? "") || path.resolve(options[name]) !== options[name]) {
      fail(`${name} must be an absolute normalized path`);
    }
  }
  if (!VERSION_PATTERN.test(options.targetVersion ?? "")) {
    fail("target version is invalid");
  }
  if (!VERSION_PATTERN.test(options.previousVersion ?? "")) {
    fail("previous version is invalid");
  }
  if (!TRANSACTION_ID_PATTERN.test(options.transactionId ?? "")) {
    fail("normalization transaction ID is invalid");
  }
  for (const name of ["expectedOperatorUid", "expectedOperatorStateGid", "expectedRootUid"]) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 0) {
      fail(`${name} is invalid`);
    }
  }
  const normalizationRoot = path.join(options.supervisorStateDir, "control-normalization");
  return Object.freeze({
    ...options,
    normalizationRoot,
    activePath: path.join(normalizationRoot, "active.json"),
    receiptPath: path.join(normalizationRoot, "last-success.json"),
    backupRoot: path.join(normalizationRoot, "backups", options.transactionId),
  });
}

function recordPath(options, record) {
  const root = {
    operator: options.operatorStateDir,
    controller: options.controllerStateDir,
    supervisor: options.supervisorStateDir,
  }[record.relativeTo];
  return path.join(root, record.path);
}

async function safeReadFile(
  filePath,
  expectedUid,
  displayPath = filePath,
  { allowEmpty = false } = {},
) {
  let named;
  try {
    named = await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.uid !== expectedUid ||
    (named.mode & 0o022) !== 0 ||
    (!allowEmpty && named.size <= 0) ||
    named.size > MAX_CONTROL_FILE_BYTES
  ) {
    fail(`control file is unsafe: ${displayPath}`);
  }
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.uid !== expectedUid ||
      (opened.mode & 0o022) !== 0 ||
      opened.size !== named.size ||
      (!allowEmpty && opened.size <= 0) ||
      opened.size > MAX_CONTROL_FILE_BYTES
    ) {
      fail(`control file changed while it was being read: ${displayPath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      fail(`control file changed while it was being read: ${displayPath}`);
    }
    return Object.freeze({ info: opened, bytes });
  } finally {
    await handle.close();
  }
}

async function safeReadJson(filePath, expectedUid, displayPath = filePath) {
  const captured = await safeReadFile(filePath, expectedUid, displayPath);
  if (!captured) {
    return null;
  }
  let value;
  try {
    value = JSON.parse(captured.bytes.toString("utf8"));
  } catch {
    fail(`control file is not valid JSON: ${displayPath}`);
  }
  return Object.freeze({ ...captured, value });
}

async function safeReadControlFile(filePath, expectedUid, displayPath = filePath) {
  const captured = await safeReadFile(filePath, expectedUid, displayPath, { allowEmpty: true });
  if (!captured) {
    return null;
  }
  try {
    return Object.freeze({ ...captured, value: JSON.parse(captured.bytes.toString("utf8")) });
  } catch {
    return Object.freeze({ ...captured, value: OPAQUE_CONTROL_RECORD });
  }
}

function directoryMatchesTrustBoundary(info, policy) {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== policy.expectedUid) {
    return false;
  }
  if ((info.mode & 0o022) === 0) {
    return true;
  }
  return (
    policy.expectedSharedGid !== null &&
    info.gid === policy.expectedSharedGid &&
    (info.mode & 0o2777) === 0o2770
  );
}

async function openDirectoryAnchor(directoryPath, policy) {
  const named = await fsp.lstat(directoryPath);
  if (!directoryMatchesTrustBoundary(named, policy)) {
    fail(`control directory is unsafe: ${directoryPath}`);
  }
  const handle = await fsp.open(
    directoryPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      !directoryMatchesTrustBoundary(opened, policy)
    ) {
      fail(`control directory changed while it was being opened: ${directoryPath}`);
    }
    return Object.freeze({ directoryPath, policy, handle, dev: opened.dev, ino: opened.ino });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openControlAnchors(options) {
  const anchors = {};
  try {
    anchors.operator = await openDirectoryAnchor(
      options.operatorStateDir,
      Object.freeze({
        expectedUid: options.expectedOperatorUid,
        expectedSharedGid: options.expectedOperatorStateGid,
      }),
    );
    anchors.controller = await openDirectoryAnchor(
      options.controllerStateDir,
      Object.freeze({ expectedUid: options.expectedRootUid, expectedSharedGid: null }),
    );
    anchors.supervisor = await openDirectoryAnchor(
      options.supervisorStateDir,
      Object.freeze({ expectedUid: options.expectedRootUid, expectedSharedGid: null }),
    );
    return Object.freeze(anchors);
  } catch (error) {
    await Promise.all(
      Object.values(anchors).map((anchor) => anchor.handle.close().catch(() => undefined)),
    );
    throw error;
  }
}

function anchoredRecordPath(anchors, record) {
  if (path.basename(record.path) !== record.path) {
    fail(`control record path is not a fixed basename: ${record.key}`);
  }
  return `/proc/self/fd/${anchors[record.relativeTo].handle.fd}/${record.path}`;
}

async function syncAndCloseControlAnchors(anchors) {
  let failure = null;
  for (const anchor of Object.values(anchors)) {
    try {
      await anchor.handle.sync();
      const visible = await fsp.lstat(anchor.directoryPath);
      if (
        !visible.isDirectory() ||
        visible.isSymbolicLink() ||
        visible.dev !== anchor.dev ||
        visible.ino !== anchor.ino ||
        !directoryMatchesTrustBoundary(visible, anchor.policy)
      ) {
        fail(`control directory changed during normalization: ${anchor.directoryPath}`);
      }
    } catch (error) {
      failure ??= error;
    }
    await anchor.handle.close().catch((error) => {
      failure ??= error;
    });
  }
  if (failure) {
    throw failure;
  }
}

export function classifyProtectedLocalControl(records) {
  let takeoverRequired = false;
  for (const record of CONTROL_RECORDS) {
    const value = records[record.key] ?? null;
    if (value === null) {
      continue;
    }
    if (value === OPAQUE_CONTROL_RECORD) {
      takeoverRequired = true;
      continue;
    }
    const schemaVersion = Number(value.schemaVersion);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      takeoverRequired = true;
      continue;
    }
    if (!record.supportedSchemas.includes(schemaVersion)) {
      const maximum = Math.max(...record.supportedSchemas);
      if (schemaVersion > maximum && record.relativeTo !== "operator") {
        fail(`unknown newer lifecycle-control schema: ${record.key} v${schemaVersion}`);
      }
      takeoverRequired = true;
    }
  }
  const supportedValue = (key) => {
    const record = CONTROL_RECORDS.find((candidate) => candidate.key === key);
    const value = records[key] ?? null;
    const schemaVersion = Number(value?.schemaVersion);
    return record &&
      value !== OPAQUE_CONTROL_RECORD &&
      value !== null &&
      typeof value === "object" &&
      record.supportedSchemas.includes(schemaVersion)
      ? value
      : null;
  };
  const supervisorTransaction = supportedValue("supervisorTransaction");
  if (supervisorTransaction) {
    return Object.freeze({
      strategy: "STANDARD_RECOVERY",
      reason: "root-supervisor-authority-preserved",
    });
  }
  const rootProductTransaction = supportedValue("rootProductTransaction");
  if (
    rootProductTransaction &&
    (rootProductTransaction.durableCommitDecision !== false ||
      !new Set(["restored", "product-recovered"]).has(rootProductTransaction.phase))
  ) {
    return Object.freeze({
      strategy: "STANDARD_RECOVERY",
      reason: "root-product-authority-preserved",
    });
  }
  const controllerProductJournal = supportedValue("controllerProductJournal");
  if (controllerProductJournal && controllerProductJournal.phase !== "restored") {
    return Object.freeze({
      strategy: "STANDARD_RECOVERY",
      reason: "root-controller-authority-preserved",
    });
  }
  const legacyKeys = [
    "operatorJournal",
    "adoptionReceipt",
    "controllerHint",
    "legacyControllerSelection",
    "rootAdoptionReceipt",
  ];
  if (
    takeoverRequired ||
    legacyKeys.some((key) => records[key] !== null && records[key] !== undefined) ||
    (records.rootProductTransaction !== null && records.rootProductTransaction !== undefined) ||
    (records.controllerProductJournal !== null && records.controllerProductJournal !== undefined)
  ) {
    return Object.freeze({
      strategy: "UNIVERSAL_TAKEOVER",
      reason: "legacy-control-quarantined",
    });
  }
  return Object.freeze({ strategy: "STANDARD", reason: "canonical-control" });
}

async function writeAtomicJson(filePath, value, mode = 0o600) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await fsp.open(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    mode,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directoryPath) {
  const directory = await fsp.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function validateActiveFiles(options, files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > CONTROL_RECORDS.length) {
    fail("active normalization journal file inventory is invalid");
  }
  const seen = new Set();
  return Object.freeze(
    files.map((file) => {
      exactKeys(
        file,
        ["key", "path", "backupName", "digest", "mode", "uid", "gid"],
        "active normalization file",
      );
      const index = CONTROL_RECORDS.findIndex((record) => record.key === file.key);
      const record = CONTROL_RECORDS[index];
      const expectedUid =
        record?.relativeTo === "operator" ? options.expectedOperatorUid : options.expectedRootUid;
      const expectedBackupName =
        index < 0 ? null : `${String(index).padStart(2, "0")}-${record.key}.json`;
      if (
        !record ||
        seen.has(record.key) ||
        file.path !== recordPath(options, record) ||
        file.backupName !== expectedBackupName ||
        !/^sha256:[a-f0-9]{64}$/u.test(file.digest ?? "") ||
        !Number.isSafeInteger(file.mode) ||
        file.mode < 0 ||
        file.mode > 0o777 ||
        file.uid !== expectedUid ||
        !Number.isSafeInteger(file.gid) ||
        file.gid < 0
      ) {
        fail("active normalization journal file inventory is mismatched");
      }
      seen.add(record.key);
      return Object.freeze({ ...file });
    }),
  );
}

async function loadActive(options, { bindIdentity = true } = {}) {
  const read = await safeReadJson(options.activePath, options.expectedRootUid);
  if (!read) {
    return null;
  }
  const value = read.value;
  exactKeys(
    value,
    [
      "schemaVersion",
      "transactionId",
      "previousVersion",
      "targetVersion",
      "phase",
      "files",
      "preparedAt",
      "boundaryCommittedAt",
      "journalDigest",
    ],
    "active normalization journal",
  );
  const unsigned = { ...value };
  delete unsigned.journalDigest;
  if (
    value.schemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
    (bindIdentity && value.transactionId !== options.transactionId) ||
    (bindIdentity && value.previousVersion !== options.previousVersion) ||
    (bindIdentity && value.targetVersion !== options.targetVersion) ||
    !["prepared", "boundary-committed"].includes(value.phase) ||
    !Array.isArray(value.files) ||
    value.journalDigest !== sha256(canonical(unsigned))
  ) {
    fail("active normalization journal is invalid or mismatched");
  }
  return Object.freeze({ ...value, files: validateActiveFiles(options, value.files) });
}

function journal(options, phase, files, preparedAt, boundaryCommittedAt = null) {
  const unsigned = Object.freeze({
    schemaVersion: NORMALIZATION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    previousVersion: options.previousVersion,
    targetVersion: options.targetVersion,
    phase,
    files,
    preparedAt,
    boundaryCommittedAt,
  });
  return Object.freeze({ ...unsigned, journalDigest: sha256(canonical(unsigned)) });
}

export async function prepareProtectedLocalControlNormalization(input) {
  const options = validateOptions(input);
  const existing = await loadActive(options);
  if (existing) {
    return Object.freeze({ strategy: "UNIVERSAL_TAKEOVER", ...existing });
  }

  const anchors = await openControlAnchors(options);
  let activeCreated = false;
  let failure = null;
  let result = null;
  try {
    const records = {};
    const captures = [];
    for (const [index, record] of CONTROL_RECORDS.entries()) {
      const filePath = recordPath(options, record);
      const expectedUid =
        record.relativeTo === "operator" ? options.expectedOperatorUid : options.expectedRootUid;
      const captured = await safeReadControlFile(
        anchoredRecordPath(anchors, record),
        expectedUid,
        filePath,
      );
      records[record.key] = captured?.value ?? null;
      if (captured) {
        captures.push({
          index,
          record,
          path: filePath,
          bytes: captured.bytes,
          mode: captured.info.mode & 0o777,
          uid: captured.info.uid,
          gid: captured.info.gid,
          digest: sha256(captured.bytes),
        });
      }
    }
    const classification = classifyProtectedLocalControl(records);
    if (classification.strategy !== "UNIVERSAL_TAKEOVER") {
      result = classification;
    } else {
      await fsp.mkdir(options.backupRoot, { recursive: true, mode: 0o700 });
      const files = [];
      for (const capture of captures) {
        const backupName = `${String(capture.index).padStart(2, "0")}-${capture.record.key}.json`;
        const backupPath = path.join(options.backupRoot, backupName);
        const handle = await fsp.open(
          backupPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(capture.bytes);
          await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        files.push(
          Object.freeze({
            key: capture.record.key,
            path: capture.path,
            backupName,
            digest: capture.digest,
            mode: capture.mode,
            uid: capture.uid,
            gid: capture.gid,
          }),
        );
      }
      await syncDirectory(options.backupRoot);
      const preparedAt = new Date(options.now?.() ?? Date.now()).toISOString();
      const active = journal(options, "prepared", files, preparedAt);
      await writeAtomicJson(options.activePath, active);
      activeCreated = true;
      for (const file of files) {
        const record = CONTROL_RECORDS.find((candidate) => candidate.key === file.key);
        const current = await safeReadFile(
          anchoredRecordPath(anchors, record),
          file.uid,
          file.path,
          { allowEmpty: true },
        );
        if (!current || sha256(current.bytes) !== file.digest) {
          fail(`control file changed before normalization: ${file.path}`);
        }
        await fsp.unlink(anchoredRecordPath(anchors, record));
      }
      result = Object.freeze({ strategy: "UNIVERSAL_TAKEOVER", ...active });
    }
  } catch (error) {
    failure = error;
  }
  try {
    await syncAndCloseControlAnchors(anchors);
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    if (activeCreated) {
      await rollbackProtectedLocalControlNormalization(options).catch(() => undefined);
    } else {
      await fsp.rm(options.backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw failure;
  }
  return result;
}

export async function markProtectedLocalBoundaryCommitted(input) {
  const options = validateOptions(input);
  const active = await loadActive(options);
  if (!active) {
    fail("no active normalization exists");
  }
  if (active.phase === "boundary-committed") {
    return active;
  }
  const committed = journal(
    options,
    "boundary-committed",
    active.files,
    active.preparedAt,
    new Date(options.now?.() ?? Date.now()).toISOString(),
  );
  await writeAtomicJson(options.activePath, committed);
  return committed;
}

function successReceipt(options, active) {
  const unsigned = Object.freeze({
    schemaVersion: NORMALIZATION_SCHEMA_VERSION,
    transactionId: active.transactionId,
    previousVersion: active.previousVersion,
    targetVersion: active.targetVersion,
    fileCount: active.files.length,
    fileSetDigest: sha256(canonical(active.files)),
    outcome: "committed",
    committedAt: active.boundaryCommittedAt,
  });
  return Object.freeze({ ...unsigned, receiptDigest: sha256(canonical(unsigned)) });
}

function validateSuccessReceipt(value, options = null) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "transactionId",
      "previousVersion",
      "targetVersion",
      "fileCount",
      "fileSetDigest",
      "outcome",
      "committedAt",
      "receiptDigest",
    ],
    "normalization success receipt",
  );
  const unsigned = { ...value };
  delete unsigned.receiptDigest;
  if (
    value.schemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
    !TRANSACTION_ID_PATTERN.test(value.transactionId ?? "") ||
    !VERSION_PATTERN.test(value.previousVersion ?? "") ||
    !VERSION_PATTERN.test(value.targetVersion ?? "") ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.fileSetDigest ?? "") ||
    value.outcome !== "committed" ||
    !Number.isFinite(Date.parse(value.committedAt ?? "")) ||
    value.receiptDigest !== sha256(canonical(unsigned)) ||
    (options !== null && value.transactionId !== options.transactionId) ||
    (options !== null && value.previousVersion !== options.previousVersion) ||
    (options !== null && value.targetVersion !== options.targetVersion)
  ) {
    fail("normalization success receipt is invalid");
  }
  return Object.freeze(value);
}

export async function commitProtectedLocalControlNormalization(input) {
  const options = validateOptions(input);
  const active = await loadActive(options);
  if (!active) {
    const existing = await safeReadJson(options.receiptPath, options.expectedRootUid);
    if (!existing) {
      fail("normalization has neither active journal nor success receipt");
    }
    const receipt = validateSuccessReceipt(existing.value, options);
    await fsp.rm(options.backupRoot, { recursive: true, force: true });
    await syncDirectory(path.dirname(options.backupRoot));
    return receipt;
  }
  if (active.phase !== "boundary-committed") {
    fail("normalization boundary is not durably committed");
  }
  const receipt = successReceipt(options, active);
  await writeAtomicJson(options.receiptPath, receipt);
  await fsp.unlink(options.activePath);
  await syncDirectory(path.dirname(options.activePath));
  await fsp.rm(options.backupRoot, { recursive: true, force: true });
  await syncDirectory(path.dirname(options.backupRoot));
  return validateSuccessReceipt(receipt, options);
}

export async function rollbackProtectedLocalControlNormalization(input) {
  const options = validateOptions(input);
  const active = await loadActive(options);
  if (!active) {
    return Object.freeze({ outcome: "nothing-to-restore" });
  }
  if (active.phase !== "prepared") {
    fail("a committed boundary cannot be rolled back as legacy");
  }

  const anchors = await openControlAnchors(options);
  let failure = null;
  try {
    for (const file of active.files) {
      const backupPath = path.join(options.backupRoot, file.backupName);
      const backup = await safeReadFile(backupPath, options.expectedRootUid, backupPath, {
        allowEmpty: true,
      });
      if (!backup || sha256(backup.bytes) !== file.digest) {
        fail(`normalization backup is missing or mismatched: ${file.backupName}`);
      }
      const record = CONTROL_RECORDS.find((candidate) => candidate.key === file.key);
      const accessPath = anchoredRecordPath(anchors, record);
      const existing = await safeReadFile(accessPath, file.uid, file.path, { allowEmpty: true });
      if (existing) {
        if (
          sha256(existing.bytes) !== file.digest ||
          (existing.info.mode & 0o777) !== file.mode ||
          existing.info.gid !== file.gid
        ) {
          fail(`restored control file is mismatched: ${file.path}`);
        }
        continue;
      }
      const handle = await fsp.open(
        accessPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        file.mode,
      );
      try {
        await handle.writeFile(backup.bytes);
        await handle.chmod(file.mode);
        await handle.chown(file.uid, file.gid);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    await syncAndCloseControlAnchors(anchors);
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }

  await fsp.unlink(options.activePath);
  await syncDirectory(path.dirname(options.activePath));
  await fsp.rm(options.backupRoot, { recursive: true, force: true });
  await syncDirectory(path.dirname(options.backupRoot));
  return Object.freeze({
    schemaVersion: NORMALIZATION_SCHEMA_VERSION,
    transactionId: active.transactionId,
    outcome: "restored",
    fileCount: active.files.length,
  });
}

export async function recoverProtectedLocalControlNormalization(input) {
  const options = validateOptions(input);
  const active = await loadActive(options, { bindIdentity: false });
  if (!active) {
    const existing = await safeReadJson(options.receiptPath, options.expectedRootUid);
    return existing
      ? validateSuccessReceipt(existing.value)
      : Object.freeze({ outcome: "nothing-to-recover" });
  }
  const recoveryOptions = validateOptions({
    ...options,
    transactionId: active.transactionId,
    previousVersion: active.previousVersion,
    targetVersion: active.targetVersion,
  });
  return active.phase === "boundary-committed"
    ? commitProtectedLocalControlNormalization(recoveryOptions)
    : rollbackProtectedLocalControlNormalization(recoveryOptions);
}
