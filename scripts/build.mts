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
import type { Metafile } from 'esbuild';
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

/** Host client-module identity: the plugin package name (client-modules boot id). */
const CLIENT_PLUGIN_ID = '@dsh-external/dsh-lepimemory-state';
/** The only modules the host factory `require` can resolve (platform seeds). */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
];

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
 * Read the plugin manifest and confirm the client module id is still the
 * package name (client-modules uses it as the boot row id).
 */
function readClientPluginId(): string {
  const manifestPath = path.join(PLUGIN_DIR, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
  if (manifest.name !== CLIENT_PLUGIN_ID) {
    throw new BuildError(
      'LEPI_CLIENT_ID_MISMATCH',
      `plugin package name is ${String(manifest.name)}, expected ${CLIENT_PLUGIN_ID}`,
    );
  }
  return manifest.name;
}

/**
 * Prove the bundle only reaches host seeds and its own browser-safe sources:
 * the output's external imports are exactly the seed set, and every bundled
 * input stays under `src/client/` or `src/shared/` (no node builtins, no
 * server source, no bundled React runtime).
 */
function assertClientBundle(metafile: Metafile): void {
  const outputKey = Object.keys(metafile.outputs)[0];
  const output = outputKey ? metafile.outputs[outputKey] : undefined;
  const externals = [
    ...new Set(
      (output?.imports ?? []).filter((imp) => imp.external === true).map((imp) => imp.path),
    ),
  ].sort();
  const expected = [...CLIENT_EXTERNALS].sort();
  if (externals.join('\n') !== expected.join('\n')) {
    throw new BuildError(
      'LEPI_CLIENT_EXTERNALS',
      `expected ${expected.join(', ')}; got ${externals.join(', ') || '(none)'}`,
    );
  }
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.startsWith('src/client/') && !input.startsWith('src/shared/')) {
      throw new BuildError('LEPI_CLIENT_INPUT', `unexpected bundled input ${input}`);
    }
  }
}

/**
 * Build the host client artifact: bundle the TSX entry with esbuild and wrap
 * the CJS body in the exact `window.__ModuleLoader__.load({ id, factory })`
 * envelope the host expects. A bundle/type failure exits non-zero, so
 * `make dev` never serves a stale or failed client.
 */
async function buildClient(): Promise<void> {
  const entry = path.join(PLUGIN_DIR, 'src', 'client', 'index.tsx');
  if (!fs.existsSync(entry)) {
    throw new BuildError('LEPI_CLIENT_ENTRY_MISSING', `${entry} not found`);
  }
  const pluginId = readClientPluginId();
  const esbuild = await import('esbuild');
  const banner = [
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(pluginId)},`,
    '  factory: (require) => {',
    "    'use strict';",
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
  ].join('\n');
  const footer = ['    return module.exports;', '  },', '});', ''].join('\n');
  const result = await esbuild.build({
    entryPoints: [entry],
    absWorkingDir: PLUGIN_DIR,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    external: [...CLIENT_EXTERNALS],
    loader: { '.css': 'text' },
    minify: false,
    charset: 'utf8',
    write: false,
    sourcemap: 'inline',
    metafile: true,
    banner: { js: banner },
    footer: { js: footer },
  });
  const output = result.outputFiles?.[0];
  if (!output)
    throw new BuildError('LEPI_CLIENT_OUTPUT_MISSING', 'esbuild produced no output file');
  assertClientBundle(result.metafile);
  writeFileAtomic(path.join(PLUGIN_DIR, 'client.js'), output.text);
}

async function build(): Promise<void> {
  requireDependencies();
  cleanGenerated();
  runTsc(PLUGIN_TSCONFIG); // emits lib/*.js + *.d.ts (config.d.ts feeds scripts)
  runTsc(SCRIPTS_TSCONFIG); // emits scripts/dist
  runTsc(CLIENT_TSCONFIG); // browser noEmit
  runTsc(SCRIPTS_TOOLS_TSCONFIG); // build driver noEmit
  await buildClient();
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

async function main(argv: string[]): Promise<void> {
  const flag = argv[0];
  assertPinnedNode();
  if (flag === undefined) {
    await build();
    return;
  }
  if (flag === '--install') {
    runFrozenInstall();
    await build();
    return;
  }
  if (flag === '--typecheck') {
    typecheck();
    return;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof BuildError) {
    process.stderr.write(`lepimemory-build: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `lepimemory-build: unexpected error: ${(error as Error)?.stack ?? String(error)}\n`,
  );
  process.exit(1);
});
