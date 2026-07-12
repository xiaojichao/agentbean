import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_SCOPE = '@earendil-works/pi-';
const WRAPPER_ROOT = 'packages/pi-management-runtime';
const REQUIRED_PACKAGE = '@earendil-works/pi-coding-agent';
const OPTIONAL_DIRECT_PACKAGES = new Set(['@earendil-works/pi-ai']);
const REQUIRED_VERSION = '0.80.6';
const ignoredSegments = new Set([
  '.agents', '.codex', '.git', '.next', '.omx', '.worktrees',
  'coverage', 'dist', 'docs', 'node_modules', 'playwright-report', 'test-results',
]);
const guardFiles = new Set([
  'scripts/check-phase-0-pi-boundary.mjs',
  'scripts/check-phase-0-pi-boundary.test.mjs',
]);
const seaManifestInspectorFiles = new Set([
  'scripts/build-pi-management-sea.mjs',
  'scripts/build-pi-management-sea.test.mjs',
]);
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/i;

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--workspace-root');
const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '' : defaultRoot);

function repoPath(file) {
  return relative(workspaceRoot, file).split(sep).join('/');
}

function walk(entry) {
  if (!existsSync(entry)) return [];
  const stat = statSync(entry);
  if (stat.isFile()) return [entry];
  if (!stat.isDirectory()) return [];
  return readdirSync(entry, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((dirent) => {
      if (dirent.isDirectory() && ignoredSegments.has(dirent.name)) return [];
      if (dirent.isSymbolicLink()) return [];
      return walk(resolve(entry, dirent.name));
    });
}

function firstLineContaining(source, token) {
  const index = source.split(/\r?\n/).findIndex((line) => line.includes(token));
  return index < 0 ? 1 : index + 1;
}

function fail(violations) {
  console.error(violations.join('\n'));
  process.exit(1);
}

const wrapperManifestPath = resolve(workspaceRoot, WRAPPER_ROOT, 'package.json');
if (!existsSync(wrapperManifestPath)) {
  console.error(`P0_NOT_SCAFFOLDED: ${WRAPPER_ROOT}/package.json does not exist`);
  process.exit(2);
}

const violations = [];
const scanFiles = walk(workspaceRoot)
  .filter((file) => sourceExtensions.test(file) || file.endsWith('package.json'));

for (const file of scanFiles) {
  const path = repoPath(file);
  const source = readFileSync(file, 'utf8');
  if (!source.includes(PI_SCOPE)) continue;
  if (seaManifestInspectorFiles.has(path)) {
    const sdkImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]@earendil-works\/pi-/u.test(source);
    if (!sdkImport) continue;
  }
  if (!path.startsWith(`${WRAPPER_ROOT}/`) && !guardFiles.has(path)) {
    violations.push(`${path}:${firstLineContaining(source, PI_SCOPE)}:PI_BOUNDARY_VIOLATION: only ${WRAPPER_ROOT} may use PI packages`);
  }
}

let wrapperManifest;
try {
  wrapperManifest = JSON.parse(readFileSync(wrapperManifestPath, 'utf8'));
} catch (error) {
  violations.push(`${WRAPPER_ROOT}/package.json:1:PI_MANIFEST_INVALID: ${error instanceof Error ? error.message : String(error)}`);
}

const declaredPiDependencies = Object.entries({
  ...(wrapperManifest?.dependencies ?? {}),
  ...(wrapperManifest?.devDependencies ?? {}),
  ...(wrapperManifest?.peerDependencies ?? {}),
}).filter(([name]) => name.startsWith(PI_SCOPE));

const requiredDependency = declaredPiDependencies.find(([name]) => name === REQUIRED_PACKAGE);
const unexpectedDependencies = declaredPiDependencies.filter(([name]) => name !== REQUIRED_PACKAGE && !OPTIONAL_DIRECT_PACKAGES.has(name));
if (!requiredDependency || unexpectedDependencies.length > 0) {
  violations.push(`${WRAPPER_ROOT}/package.json:1:PI_DEPENDENCY_SET: expected ${REQUIRED_PACKAGE} and only approved direct PI support packages`);
}
for (const [name, version] of declaredPiDependencies) {
  if (version !== REQUIRED_VERSION) {
    violations.push(`${WRAPPER_ROOT}/package.json:1:PI_DEPENDENCY_VERSION: ${name} must equal ${REQUIRED_VERSION}`);
  }
}

const lockfilePath = resolve(workspaceRoot, 'package-lock.json');
if (!existsSync(lockfilePath)) {
  violations.push('package-lock.json:1:PI_LOCK_MISSING: package-lock.json is required');
} else {
  try {
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    const wrapperLock = lockfile.packages?.[WRAPPER_ROOT];
    for (const [name] of declaredPiDependencies) {
      const locked = lockfile.packages?.[`node_modules/${name}`];
      if (!locked || locked.version !== REQUIRED_VERSION) {
        violations.push(`package-lock.json:1:PI_LOCK_VERSION: ${name} must resolve to ${REQUIRED_VERSION}`);
      }
      const declared = wrapperLock?.dependencies?.[name];
      if (declared !== REQUIRED_VERSION) {
        violations.push(`package-lock.json:1:PI_LOCK_DECLARATION: ${name} must equal ${REQUIRED_VERSION}`);
      }
    }
  } catch (error) {
    violations.push(`package-lock.json:1:PI_LOCK_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (violations.length > 0) fail(violations);

console.log(`Phase 0 PI boundary check passed: ${REQUIRED_PACKAGE}@${REQUIRED_VERSION} is isolated to ${WRAPPER_ROOT}.`);
