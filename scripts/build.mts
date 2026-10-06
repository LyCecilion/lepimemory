#!/usr/bin/env node
/**
 * Lepimemory build driver (type-erased, run directly by the pinned Node).
 *
 *   .runtime/bin/node scripts/build.mts              # build sources -> artifacts
 *   .runtime/bin/node scripts/build.mts --install    # frozen install, then build
 *   .runtime/bin/node scripts/build.mts --typecheck  # declarations + noEmit checks
 *
 * It depends on no generated file: only Node builtins and the shared version
 * pins. The TypeScript/esbuild runtime imports only happen after the frozen
 * install has materialised the toolchain. Any failure exits non-zero, so
 * `make dev` never launches a stale artifact.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NODE_VERSION, PNPM_VERSION } from '../dsh/plugins/dsh-lepimemory-state/src/shared/pins.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'dsh', 'plugins', 'dsh-lepimemory-state');
const RUNTIME_BIN = path.join(REPO_ROOT, '.runtime', 'bin');
const PINNED_NODE = path.join(RUNTIME_BIN, 'node');
const PINNED_PNPM = path.join(RUNTIME_BIN, 'pnpm');
const ROOT_LOCK = path.join(REPO_ROOT, 'pnpm-lock.yaml');
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const PLUGIN_TSCONFIG = path.join(PLUGIN_DIR, 'tsconfig.json');
const SCRIPTS_TSCONFIG = path.join(REPO_ROOT, 'scripts', 'tsconfig.json');
const SCRIPTS_TOOLS_TSCONFIG = path.join(REPO_ROOT, 'scripts', 'tsconfig.tools.json');
const CLIENT_TSCONFIG = path.join(PLUGIN_DIR, 'src', 'client', 'tsconfig.json');

const USAGE = 'usage: build.mts [--install | --typecheck]';

class BuildError extends Error {
  code: string;
  constructor(code: string, detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BuildError';
    this.code = code;
  }
}

function info(message: string): void {
  process.stderr.write(`lepimemory-build: ${message}\n`);
}

function assertPinnedNode(): void {
  if (process.version !== NODE_VERSION) {
    throw new BuildError(
      'LEPI_NODE_VERSION_MISMATCH',
      `needs ${NODE_VERSION}, running ${process.version}; run 'make bootstrap'`,
    );
  }
  if (!fs.existsSync(PINNED_NODE)) {
    throw new BuildError('LEPI_NODE_UNBOUND', "missing .runtime/bin/node; run 'make bootstrap'");
  }
  if (fs.realpathSync(process.execPath) !== fs.realpathSync(PINNED_NODE)) {
    throw new BuildError('LEPI_NODE_UNBOUND', 'not the pinned .runtime/bin/node; run through make');
  }
}

function requireDependencies(): void {
  if (!fs.existsSync(TSC) || !fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'esbuild'))) {
    throw new BuildError('LEPI_DEPS_MISSING', 'missing dependencies; run make install-profile');
  }
}

function runFrozenInstall(): void {
  if (!fs.existsSync(PINNED_PNPM)) {
    throw new BuildError('LEPI_PNPM_MISSING', "missing .runtime/bin/pnpm; run 'make bootstrap'");
  }
  if (!fs.existsSync(ROOT_LOCK)) {
    throw new BuildError(
      'LEPI_LOCKFILE_MISSING',
      'root pnpm-lock.yaml absent; the initial lock must be generated once before frozen install',
    );
  }
  const version = spawnSync(PINNED_PNPM, ['--version'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== PNPM_VERSION) {
    throw new BuildError('LEPI_PNPM_VERSION_MISMATCH', `expected pnpm ${PNPM_VERSION}`);
  }
  const result = spawnSync(PINNED_PNPM, ['install', '--frozen-lockfile'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new BuildError('LEPI_INSTALL_FAILED', 'frozen pnpm install failed');
  }
}

function runTsc(project: string, extra: string[] = []): void {
  const result = spawnSync(process.execPath, [TSC, '-p', project, ...extra], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new BuildError(
      'LEPI_TYPECHECK_FAILED',
      `tsc -p ${path.relative(REPO_ROOT, project)} exited ${result.status}`,
    );
  }
}

/** Remove only the generated areas; never assets, tests, sources or profile. */
function cleanGenerated(): void {
  for (const target of [path.join(PLUGIN_DIR, 'lib'), path.join(REPO_ROOT, 'scripts', 'dist')]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  for (const file of [path.join(PLUGIN_DIR, 'client.js'), path.join(PLUGIN_DIR, 'client.js.map')]) {
    fs.rmSync(file, { force: true });
  }
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Build the host client artifact. Phase-2 transitional step: copy the migrated
 * lazy-CJS entry verbatim. Phase 4 replaces this with the esbuild factory bundle
 * (no existence-based fallback survives the cutover).
 */
function buildClient(): void {
  const entry = path.join(PLUGIN_DIR, 'src', 'client', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new BuildError('LEPI_CLIENT_ENTRY_MISSING', `${entry} not found`);
  }
  writeFileAtomic(path.join(PLUGIN_DIR, 'client.js'), fs.readFileSync(entry, 'utf8'));
}

function build(): void {
  requireDependencies();
  cleanGenerated();
  runTsc(PLUGIN_TSCONFIG); // emits lib/*.js + *.d.ts (config.d.ts feeds scripts)
  runTsc(SCRIPTS_TSCONFIG); // emits scripts/dist
  runTsc(CLIENT_TSCONFIG); // browser noEmit
  runTsc(SCRIPTS_TOOLS_TSCONFIG); // build driver noEmit
  buildClient();
  info('build complete');
}

function typecheck(): void {
  requireDependencies();
  runTsc(PLUGIN_TSCONFIG, ['--emitDeclarationOnly']); // refresh declarations only
  runTsc(SCRIPTS_TSCONFIG, ['--noEmit']);
  runTsc(CLIENT_TSCONFIG);
  runTsc(SCRIPTS_TOOLS_TSCONFIG);
  info('typecheck complete');
}

function main(argv: string[]): void {
  const flag = argv[0];
  assertPinnedNode();
  if (flag === undefined) {
    build();
    return;
  }
  if (flag === '--install') {
    runFrozenInstall();
    build();
    return;
  }
  if (flag === '--typecheck') {
    typecheck();
    return;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof BuildError) {
    process.stderr.write(`lepimemory-build: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `lepimemory-build: unexpected error: ${(error as Error)?.stack ?? String(error)}\n`,
  );
  process.exit(1);
}
