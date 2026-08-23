import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative, sep } from 'node:path';
import process, { getuid } from 'node:process';

import {
  COLLAB_MEMBER_REF_PREFIX,
  isCollabGitOid,
  isCollabMemberId,
  isCollabProjectId,
  type CollabGitOid,
  type CollabProjectId,
} from '@claudian-collab/protocol';

export type GitReceivePackPolicyErrorCode =
  | 'closed'
  | 'policy-invalid'
  | 'storage-unavailable';

export class GitReceivePackPolicyError extends Error {
  readonly code: GitReceivePackPolicyErrorCode;

  constructor(code: GitReceivePackPolicyErrorCode) {
    super(`git-receive-pack-policy.error.${code}`);
    this.name = 'GitReceivePackPolicyError';
    this.code = code;
  }
}

export interface GitReceivePackPolicyOptions {
  readonly gitExecutable: string;
  readonly maximumBlobBytes: number;
  readonly maximumExpandedTreeEntries: number;
  readonly maximumMetadataOutputBytes: number;
  readonly maximumRepositoryBytes: number;
  readonly maximumTreeEntries: number;
  readonly repositoryRoot: string;
}

export interface GitReceivePackPolicyResult {
  readonly newOid: CollabGitOid;
  readonly oldOid: CollabGitOid;
  readonly personalRef: string;
}

export interface PreparedGitReceivePackPolicy {
  readonly environment: Readonly<Record<string, string>>;
  close(): Promise<void>;
  readResult(): Promise<GitReceivePackPolicyResult | undefined>;
}

interface PolicyDocument {
  readonly gitExecutable: string;
  readonly maximumBlobBytes: number;
  readonly maximumExpandedTreeEntries: number;
  readonly maximumMetadataOutputBytes: number;
  readonly maximumRepositoryBytes: number;
  readonly maximumTreeEntries: number;
  readonly personalRef: string;
  readonly resultPath: string;
  readonly schemaVersion: 1;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const HOOK_MODE = 0o700;
const WORK_ROOT_NAME = '.claudian-receive-pack';

const HOOK_BODY = String.raw`'use strict';
const { closeSync, fsyncSync, openSync, readFileSync, writeSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { dirname } = require('node:path');

const INVENTORY_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))(?:\..*)?$/iu;
const WINDOWS_INVALID = /[<>:"\\|?*]/u;
const RESERVED_ROOTS = new Set(['.claudian', '.git', 'workspace']);

function rejectPolicy() { throw new Error('policy-rejected'); }
function exactObject(value, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) rejectPolicy();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    rejectPolicy();
  }
  return value;
}
function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) rejectPolicy();
  return value;
}
function configuration() {
  const path = process.env.CLAUDIAN_RECEIVE_POLICY_PATH;
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) rejectPolicy();
  const value = exactObject(JSON.parse(readFileSync(path, 'utf8')), [
    'gitExecutable', 'maximumBlobBytes', 'maximumExpandedTreeEntries',
    'maximumMetadataOutputBytes', 'maximumRepositoryBytes', 'maximumTreeEntries',
    'personalRef', 'resultPath', 'schemaVersion',
  ]);
  if (
    value.schemaVersion !== 1
    || typeof value.gitExecutable !== 'string'
    || value.gitExecutable.length === 0
    || typeof value.personalRef !== 'string'
    || !value.personalRef.startsWith('refs/heads/members/')
    || typeof value.resultPath !== 'string'
    || value.resultPath.length === 0
  ) rejectPolicy();
  for (const key of [
    'maximumBlobBytes', 'maximumExpandedTreeEntries', 'maximumMetadataOutputBytes',
    'maximumRepositoryBytes', 'maximumTreeEntries',
  ]) positiveInteger(value[key]);
  return value;
}
function gitEnvironment() {
  const environment = {
    GIT_ASKPASS: '/bin/false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DIR: process.env.GIT_DIR || '.',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    SSH_ASKPASS: '/bin/false',
  };
  for (const name of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_OBJECT_DIRECTORY',
    'GIT_QUARANTINE_PATH',
  ]) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}
function git(config, arguments_, input, maximumBytes, environment) {
  const result = spawnSync(config.gitExecutable, arguments_, {
    cwd: '.',
    encoding: null,
    env: environment || gitEnvironment(),
    input,
    maxBuffer: maximumBytes,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    rejectPolicy();
  }
  return result.stdout;
}
function canonicalObjectIds(config, oidPattern) {
  const environment = gitEnvironment();
  if (
    typeof environment.GIT_ALTERNATE_OBJECT_DIRECTORIES !== 'string'
    || environment.GIT_ALTERNATE_OBJECT_DIRECTORIES.length === 0
    || typeof environment.GIT_OBJECT_DIRECTORY !== 'string'
    || typeof environment.GIT_QUARANTINE_PATH !== 'string'
    || environment.GIT_OBJECT_DIRECTORY !== environment.GIT_QUARANTINE_PATH
  ) rejectPolicy();
  environment.GIT_OBJECT_DIRECTORY = dirname(config.resultPath);
  delete environment.GIT_QUARANTINE_PATH;
  const output = git(config, [
    'cat-file', '--batch-all-objects', '--unordered',
    '--batch-check=%(objectname)',
  ], undefined, config.maximumMetadataOutputBytes, environment).toString('ascii').trim();
  const result = new Set();
  for (const oid of output.split('\n').filter(Boolean)) {
    if (!oidPattern.test(oid) || result.has(oid)) rejectPolicy();
    result.add(oid);
  }
  return result;
}
function refs(config) {
  const output = git(
    config,
    ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs'],
    undefined,
    config.maximumMetadataOutputBytes,
  ).toString('utf8');
  const result = new Map();
  for (const line of output.split('\n').filter(Boolean)) {
    const separator = line.indexOf('\0');
    if (separator <= 0 || line.indexOf('\0', separator + 1) !== -1) rejectPolicy();
    const name = line.slice(0, separator);
    const oid = line.slice(separator + 1);
    if (result.has(name) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) rejectPolicy();
    result.set(name, oid);
  }
  return result;
}
function inventory(config) {
  const output = git(config, [
    'cat-file', '--batch-all-objects', '--unordered',
    '--batch-check=%(objectname) %(objecttype) %(objectsize)',
  ], undefined, config.maximumMetadataOutputBytes).toString('utf8').trim();
  if (output.length === 0) rejectPolicy();
  const result = new Map();
  let repositoryBytes = 0;
  const treeOids = [];
  for (const line of output.split('\n')) {
    const match = INVENTORY_LINE.exec(line);
    const oid = match && match[1];
    const type = match && match[2];
    const size = Number(match && match[3]);
    if (!oid || !type || !Number.isSafeInteger(size) || size < 0 || result.has(oid)) rejectPolicy();
    repositoryBytes += size;
    if (!Number.isSafeInteger(repositoryBytes) || repositoryBytes > config.maximumRepositoryBytes) {
      rejectPolicy();
    }
    if (type === 'blob' && size > config.maximumBlobBytes) rejectPolicy();
    if (type === 'tree') treeOids.push(oid);
    else if (type !== 'blob' && type !== 'commit') rejectPolicy();
    result.set(oid, { oid, size, type });
  }
  return { objects: result, treeOids };
}
function parseTreeBatch(body, expectedOids, oidBytes, config) {
  const result = new Map();
  let offset = 0;
  let materialized = 0;
  for (const expectedOid of expectedOids) {
    const headerEnd = body.indexOf(0x0a, offset);
    if (headerEnd < 0) rejectPolicy();
    const match = INVENTORY_LINE.exec(body.subarray(offset, headerEnd).toString('ascii'));
    const size = Number(match && match[3]);
    if (!match || match[1] !== expectedOid || match[2] !== 'tree' || !Number.isSafeInteger(size)) {
      rejectPolicy();
    }
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= body.length || body[end] !== 0x0a) rejectPolicy();
    const entries = [];
    let entryOffset = start;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (entryOffset < end) {
      const modeEnd = body.indexOf(0x20, entryOffset);
      const nameEnd = body.indexOf(0x00, modeEnd + 1);
      if (modeEnd <= entryOffset || nameEnd <= modeEnd || nameEnd + oidBytes > end) rejectPolicy();
      let name;
      try { name = decoder.decode(body.subarray(modeEnd + 1, nameEnd)); }
      catch { rejectPolicy(); }
      entries.push({
        mode: body.subarray(entryOffset, modeEnd).toString('ascii'),
        name,
        oid: body.subarray(nameEnd + 1, nameEnd + 1 + oidBytes).toString('hex'),
      });
      entryOffset = nameEnd + 1 + oidBytes;
    }
    if (entries.length > config.maximumTreeEntries) rejectPolicy();
    materialized += entries.length;
    if (materialized > config.maximumExpandedTreeEntries) rejectPolicy();
    result.set(expectedOid, entries);
    offset = end + 1;
  }
  if (offset !== body.length) rejectPolicy();
  return result;
}
function invalidControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
function validateSegment(segment, config) {
  if (segment.length > 120) rejectPolicy();
  if (
    segment.length === 0 || segment === '.' || segment === '..'
    || invalidControl(segment) || WINDOWS_INVALID.test(segment) || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED.test(segment)
    || RESERVED_ROOTS.has(segment.normalize('NFC').toLocaleLowerCase('en-US'))
  ) rejectPolicy();
}
function validateTrees(rootTrees, trees, objects, config) {
  let expanded = 0;
  for (const root of rootTrees) {
    const comparisons = new Map();
    const stack = [{ oid: root, prefix: '' }];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = trees.get(current.oid);
      if (!entries) rejectPolicy();
      for (const entry of entries) {
        expanded += 1;
        if (expanded > config.maximumExpandedTreeEntries) rejectPolicy();
        validateSegment(entry.name, config);
        const path = current.prefix ? current.prefix + '/' + entry.name : entry.name;
        if (path.length > 240) rejectPolicy();
        const comparison = path.normalize('NFC').toLocaleLowerCase('en-US');
        const previous = comparisons.get(comparison);
        if (previous !== undefined && previous !== path) rejectPolicy();
        comparisons.set(comparison, path);
        const object = objects.get(entry.oid);
        if (entry.mode === '40000' || entry.mode === '040000') {
          if (!object || object.type !== 'tree') rejectPolicy();
          stack.push({ oid: entry.oid, prefix: path });
        } else if (entry.mode === '100644' || entry.mode === '100755') {
          if (!object || object.type !== 'blob') rejectPolicy();
        } else rejectPolicy();
      }
    }
  }
}
function validate() {
  const config = configuration();
  const commandBody = readFileSync(0);
  if (commandBody.length > 4096) rejectPolicy();
  const lines = commandBody.toString('utf8').split('\n').filter(Boolean);
  if (lines.length !== 1) rejectPolicy();
  const parts = lines[0].split(' ');
  if (parts.length !== 3) rejectPolicy();
  const [oldOid, newOid, ref] = parts;
  const objectFormat = git(
    config,
    ['rev-parse', '--show-object-format'],
    undefined,
    64,
  ).toString('ascii').trim();
  const length = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
  const oidPattern = length === 40 ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u;
  if (
    length === 0 || !oidPattern.test(oldOid) || !oidPattern.test(newOid)
    || /^0+$/u.test(oldOid) || /^0+$/u.test(newOid) || oldOid === newOid
    || ref !== config.personalRef
  ) rejectPolicy();
  const current = refs(config).get(config.personalRef);
  if (current !== oldOid) rejectPolicy();
  const type = git(
    config,
    ['cat-file', '--batch-check=%(objecttype)'],
    newOid + '\n',
    64,
  ).toString('ascii').trim();
  if (type !== 'commit') rejectPolicy();
  const excluded = git(
    config,
    ['rev-list', '--max-count=1', '--stdin'],
    oldOid + '\n^' + newOid + '\n',
    128,
  ).toString('ascii').trim();
  if (excluded.length !== 0) rejectPolicy();
  git(
    config,
    ['fsck', '--full', '--strict', '--no-dangling', '--no-progress'],
    undefined,
    config.maximumMetadataOutputBytes,
  );

  const repository = inventory(config);
  const canonicalObjects = canonicalObjectIds(config, oidPattern);
  const deltaOutput = git(
    config,
    ['rev-list', '--objects', '--missing=print', '--stdin'],
    newOid + '\n^' + oldOid + '\n',
    config.maximumMetadataOutputBytes,
  ).toString('utf8').trim();
  const allowedDelta = new Set();
  for (const line of deltaOutput.split('\n').filter(Boolean)) {
    if (line.startsWith('?')) rejectPolicy();
    const oid = line.split(' ', 1)[0];
    if (!oidPattern.test(oid)) rejectPolicy();
    allowedDelta.add(oid);
  }
  for (const oid of repository.objects.keys()) {
    if (!canonicalObjects.has(oid) && !allowedDelta.has(oid)) rejectPolicy();
  }
  const reachableOutput = git(
    config,
    ['rev-list', '--objects', '--missing=print', '--stdin'],
    newOid + '\n',
    config.maximumMetadataOutputBytes,
  ).toString('utf8').trim();
  for (const line of reachableOutput.split('\n').filter(Boolean)) {
    if (line.startsWith('?')) rejectPolicy();
    const oid = line.split(' ', 1)[0];
    if (!repository.objects.has(oid)) rejectPolicy();
  }
  const rootTrees = git(
    config,
    ['log', '--format=%T', '--all', '--stdin'],
    newOid + '\n',
    config.maximumMetadataOutputBytes,
  ).toString('ascii').trim().split('\n').filter(Boolean);
  if (rootTrees.length === 0 || rootTrees.some(oid => !repository.objects.has(oid))) rejectPolicy();
  const oidBytes = length / 2;
  const maximumTreeOutput = config.maximumExpandedTreeEntries * 400
    + (config.maximumExpandedTreeEntries + 1) * 82;
  const treeBody = git(
    config,
    ['cat-file', '--batch'],
    repository.treeOids.join('\n') + '\n',
    maximumTreeOutput,
  );
  const trees = parseTreeBatch(treeBody, repository.treeOids, oidBytes, config);
  validateTrees(rootTrees, trees, repository.objects, config);

  const handle = openSync(config.resultPath, 'wx', 0o600);
  try {
    writeSync(handle, JSON.stringify({ newOid, oldOid, personalRef: ref }) + '\n', null, 'utf8');
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}
try { validate(); }
catch {
  process.stderr.write('personal-ref-policy-rejected\n');
  process.exitCode = 1;
}
`;

function fail(code: GitReceivePackPolicyErrorCode): never {
  throw new GitReceivePackPolicyError(code);
}

function contained(root: string, candidate: string): boolean {
  const descendant = relative(root, candidate);
  return descendant.length > 0
    && descendant !== '..'
    && !descendant.startsWith(`..${sep}`)
    && !isAbsolute(descendant);
}

function assertOptions(options: GitReceivePackPolicyOptions): void {
  const positive = [
    options.maximumBlobBytes,
    options.maximumExpandedTreeEntries,
    options.maximumMetadataOutputBytes,
    options.maximumRepositoryBytes,
    options.maximumTreeEntries,
  ];
  if (
    options.gitExecutable.length === 0
    || options.gitExecutable.includes('\0')
    || options.gitExecutable.includes('\n')
    || positive.some(value => !Number.isSafeInteger(value) || value <= 0)
    || options.maximumBlobBytes > options.maximumRepositoryBytes
    || options.maximumTreeEntries > options.maximumExpandedTreeEntries
    || !isAbsolute(options.repositoryRoot)
    || normalize(options.repositoryRoot) !== options.repositoryRoot
    || parse(options.repositoryRoot).root === options.repositoryRoot
  ) {
    throw new TypeError('git-receive-pack-policy.options-invalid');
  }
}

function policyDocument(
  options: GitReceivePackPolicyOptions,
  personalRef: string,
  resultPath: string,
): PolicyDocument {
  return Object.freeze({
    gitExecutable: options.gitExecutable,
    maximumBlobBytes: options.maximumBlobBytes,
    maximumExpandedTreeEntries: options.maximumExpandedTreeEntries,
    maximumMetadataOutputBytes: options.maximumMetadataOutputBytes,
    maximumRepositoryBytes: options.maximumRepositoryBytes,
    maximumTreeEntries: options.maximumTreeEntries,
    personalRef,
    resultPath,
    schemaVersion: 1 as const,
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function projectWorkName(projectId: CollabProjectId): string {
  return Buffer.from(projectId, 'utf8').toString('hex');
}

async function writePrivate(path: string, contents: string, mode: number): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(path, mode);
  } catch {
    await handle?.close().catch(() => undefined);
    fail('storage-unavailable');
  }
}

class PreparedPolicy implements PreparedGitReceivePackPolicy {
  readonly environment: Readonly<Record<string, string>>;
  readonly #directory: string;
  readonly #projectDirectory: string;
  readonly #resultPath: string;
  #closePromise: Promise<void> | undefined;

  constructor(
    directory: string,
    projectDirectory: string,
    policyPath: string,
    resultPath: string,
  ) {
    this.#directory = directory;
    this.#projectDirectory = projectDirectory;
    this.#resultPath = resultPath;
    this.environment = Object.freeze({
      CLAUDIAN_RECEIVE_POLICY_PATH: policyPath,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_KEY_1: 'receive.denyDeletes',
      GIT_CONFIG_KEY_2: 'receive.denyNonFastForwards',
      GIT_CONFIG_VALUE_0: directory,
      GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_VALUE_2: 'true',
    });
  }

  async readResult(): Promise<GitReceivePackPolicyResult | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await (await import('node:fs/promises')).readFile(
        this.#resultPath,
        'utf8',
      ));
    } catch (error: unknown) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      ) return undefined;
      return fail('policy-invalid');
    }
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'newOid,oldOid,personalRef'
      || !('newOid' in value)
      || !('oldOid' in value)
      || !('personalRef' in value)
      || !isCollabGitOid(value.newOid)
      || !isCollabGitOid(value.oldOid)
      || typeof value.personalRef !== 'string'
    ) return fail('policy-invalid');
    return Object.freeze({
      newOid: value.newOid,
      oldOid: value.oldOid,
      personalRef: value.personalRef,
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= (async (): Promise<void> => {
      try {
        await rm(this.#directory, { force: true, recursive: true });
        await rmdir(this.#projectDirectory);
      } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTEMPTY') return;
        return fail('storage-unavailable');
      }
    })();
    return this.#closePromise;
  }
}

export class GitReceivePackPolicy {
  readonly #options: GitReceivePackPolicyOptions;
  readonly #workRoot: string;
  #closed = false;

  constructor(options: GitReceivePackPolicyOptions) {
    assertOptions(options);
    this.#options = options;
    this.#workRoot = join(options.repositoryRoot, WORK_ROOT_NAME);
  }

  close(): void {
    this.#closed = true;
  }

  async verifyCapability(): Promise<void> {
    this.#assertOpen();
    await this.#verifyWorkRoot();
  }

  async prepare(
    projectId: CollabProjectId,
    personalRef: string,
  ): Promise<PreparedGitReceivePackPolicy> {
    this.#assertOpen();
    const memberId = personalRef.startsWith(COLLAB_MEMBER_REF_PREFIX)
      ? personalRef.slice(COLLAB_MEMBER_REF_PREFIX.length)
      : '';
    if (!isCollabProjectId(projectId) || !isCollabMemberId(memberId)) {
      return fail('policy-invalid');
    }
    await this.#verifyWorkRoot();
    const projectDirectory = join(this.#workRoot, projectWorkName(projectId));
    await this.#verifyProjectDirectory(projectDirectory, true);
    let directory: string;
    try {
      directory = await mkdtemp(join(projectDirectory, 'operation-'));
      await chmod(directory, DIRECTORY_MODE);
    } catch {
      return fail('storage-unavailable');
    }
    const hookPath = join(directory, 'pre-receive');
    const policyPath = join(directory, 'policy.json');
    const resultPath = join(directory, 'result.json');
    try {
      if (process.execPath.includes('\n') || process.execPath.includes('\0')) {
        return fail('policy-invalid');
      }
      await writePrivate(
        hookPath,
        `#!${process.execPath}\n${HOOK_BODY}`,
        HOOK_MODE,
      );
      await writePrivate(
        policyPath,
        `${JSON.stringify(policyDocument(this.#options, personalRef, resultPath))}\n`,
        FILE_MODE,
      );
      return new PreparedPolicy(
        directory,
        projectDirectory,
        policyPath,
        resultPath,
      );
    } catch (error: unknown) {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      if (error instanceof GitReceivePackPolicyError) throw error;
      return fail('storage-unavailable');
    }
  }

  async cleanupProject(projectId: CollabProjectId): Promise<void> {
    this.#assertOpen();
    if (!isCollabProjectId(projectId)) return fail('policy-invalid');
    await this.#verifyWorkRoot();
    const projectDirectory = join(this.#workRoot, projectWorkName(projectId));
    const exists = await this.#verifyProjectDirectory(projectDirectory, false);
    if (!exists) return;
    let children: string[];
    try {
      children = await readdir(projectDirectory);
    } catch {
      return fail('storage-unavailable');
    }
    const projectReal = await realpath(projectDirectory).catch(
      () => fail('storage-unavailable'),
    );
    for (const child of children) {
      if (!child.startsWith('operation-')) return fail('storage-unavailable');
      const candidate = join(projectDirectory, child);
      try {
        const entry = await lstat(candidate);
        const candidateReal = await realpath(candidate);
        if (
          !entry.isDirectory()
          || entry.isSymbolicLink()
          || !contained(projectReal, candidateReal)
        ) return fail('storage-unavailable');
        await rm(candidate, { recursive: true });
      } catch {
        return fail('storage-unavailable');
      }
    }
    try {
      await rmdir(projectDirectory);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') return fail('storage-unavailable');
    }
  }

  #assertOpen(): void {
    if (this.#closed) fail('closed');
  }

  async #verifyWorkRoot(): Promise<void> {
    try {
      await mkdir(this.#workRoot, { mode: DIRECTORY_MODE });
    } catch (error: unknown) {
      if (!(
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'EEXIST'
      )) return fail('storage-unavailable');
    }
    try {
      const rootReal = await realpath(this.#options.repositoryRoot);
      const workReal = await realpath(this.#workRoot);
      const entry = await lstat(this.#workRoot);
      const uid = getuid?.();
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || uid === undefined
        || entry.uid !== uid
        || !contained(rootReal, workReal)
      ) return fail('storage-unavailable');
      await chmod(this.#workRoot, DIRECTORY_MODE);
    } catch {
      return fail('storage-unavailable');
    }
  }

  async #verifyProjectDirectory(
    projectDirectory: string,
    create: boolean,
  ): Promise<boolean> {
    if (create) {
      try {
        await mkdir(projectDirectory, { mode: DIRECTORY_MODE });
      } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') return fail('storage-unavailable');
      }
    }
    try {
      const workReal = await realpath(this.#workRoot);
      const projectReal = await realpath(projectDirectory);
      const entry = await lstat(projectDirectory);
      const uid = getuid?.();
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || uid === undefined
        || entry.uid !== uid
        || !contained(workReal, projectReal)
      ) return fail('storage-unavailable');
      await chmod(projectDirectory, DIRECTORY_MODE);
      return true;
    } catch (error: unknown) {
      if (!create && errorCode(error) === 'ENOENT') return false;
      return fail('storage-unavailable');
    }
  }
}
