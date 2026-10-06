#!/usr/bin/env node
/**
 * Lepimemory fixed-runtime launcher (Step 1).
 *
 * The Makefile invokes this file through the verified repository Node:
 *
 *   .runtime/bin/node scripts/dist/runtime.js install   # make install-profile
 *   .runtime/bin/node scripts/dist/runtime.js dev       # make dev
 *   .runtime/bin/node scripts/dist/runtime.js verify    # make verify
 *
 * Ownership boundary
 * ------------------
 * This launcher owns **only** the runtime plumbing: exact-Node binding, the
 * frozen pnpm install, generation of the runtime profile under $DSH_HOME, the
 * gated fixed-CLI launch, the core health gate, and the two mandated verify
 * entry points. It never edits the checked-in profile, never calls a global
 * node/pnpm/dsh, and never logs a credential value.
 *
 * Fail-closed rules mirrored from PLAN Step 1
 * -------------------------------------------
 *   - Node is the pinned official build (v24.20.0). No system Node fallback.
 *   - pnpm is the pinned 10.28.2 from .runtime/bin; install is always
 *     `--frozen-lockfile` (the root lock is materialised by the parent once).
 *   - The CLI is the locked repository install (`node_modules/@deepseek-ai/dsh`),
 *     run with `--expose-internals` like the verified wrapper.
 *   - `install` needs no new core; `dev` requires the cutover contract exported
 *     by index.js, not merely files that could still leave the old bridge active.
 *   - Provider credentials reach dsh only through `apiKeyEnv` names; values are
 *     injected into the child process env, never written to the profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT,
  loadEnvFile,
  resolveConfig,
  applyDerivedEnv,
  redactConfig,
  ConfigError,
} from '../../dsh/plugins/dsh-lepimemory-state/lib/config.js';
import type { LepiConfig, LlmRoute } from '../../dsh/plugins/dsh-lepimemory-state/lib/config.js';
import {
  NODE_VERSION,
  DSH_VERSION,
} from '../../dsh/plugins/dsh-lepimemory-state/lib/shared/pins.js';

const RUNTIME_BIN = path.join(REPO_ROOT, '.runtime', 'bin');
const PINNED_NODE = path.join(RUNTIME_BIN, 'node');

const PROFILE_NAME = 'lepimemory';
const PROFILE_SRC = path.join(REPO_ROOT, 'dsh', 'profiles', PROFILE_NAME);
const PLUGIN_DIR = path.join(REPO_ROOT, 'dsh', 'plugins', 'dsh-lepimemory-state');

const CLI_ANCHOR = path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const CLI_BIN = path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

/** New-core modules whose absence keeps `dev` from launching the legacy bridge. */
const CORE_MODULES = [
  'config.js',
  'store.js',
  'evidence.js',
  'processor.js',
  'contracts.js',
  'control.js',
  'admission.js',
  'history.js',
];
/** Helper packages the plugin must pin to the runtime version. */
const PLUGIN_HELPER_DEPS = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-system-prompt',
];

const GENERATED_MARKER = '.lepimemory-runtime.json';
const MARKER_CREATOR = 'lepimemory-runtime';
const PROFILE_PATCH_SRC = path.join(PROFILE_SRC, 'cordis.patch.yml');
const HEALTH_TIMEOUT_MS = 90000;
const HEALTH_INTERVAL_MS = 500;

/** Minimal manifest surface this launcher reads. */
interface Manifest {
  version?: string;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}
/** Generated runtime profile paths (one profile name). */
interface ProfilePaths {
  dir: string;
  patch: string;
  pkg: string;
  nodeModules: string;
  symlink: string;
  marker: string;
}

// ── errors / logging ─────────────────────────────────────────────────
class LaunchError extends Error {
  readonly code: string;
  readonly detail: string | null;
  constructor(code: string, detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LaunchError';
    this.code = code;
    this.detail = detail;
  }
}

/** Diagnostics only — never prints a credential value. */
function info(message: string): void {
  process.stderr.write(`lepimemory-runtime: ${message}\n`);
}
function warn(message: string): void {
  process.stderr.write(`lepimemory-runtime: warning: ${message}\n`);
}

// ── small fs helpers ─────────────────────────────────────────────────
function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function yamlStr(value: unknown): string {
  // JSON double-quoted scalars are valid YAML and keep non-ASCII literal.
  return JSON.stringify(String(value));
}

// ── exact Node binding ───────────────────────────────────────────────
function assertPinnedNode(): void {
  if (process.version !== NODE_VERSION) {
    throw new LaunchError(
      'LEPI_NODE_VERSION_MISMATCH',
      `needs ${NODE_VERSION}, running ${process.version}; use 'make bootstrap' then make`,
    );
  }
  if (!fs.existsSync(PINNED_NODE)) {
    throw new LaunchError('LEPI_NODE_UNBOUND', "missing .runtime/bin/node; run 'make bootstrap'");
  }
  const running = fs.realpathSync(process.execPath);
  const pinned = fs.realpathSync(PINNED_NODE);
  if (running !== pinned) {
    throw new LaunchError(
      'LEPI_NODE_UNBOUND',
      'not the pinned .runtime/bin/node; run through make',
    );
  }
}

// ── installation anchors / core plugin versions ──────────────────────
function assertInstallation(): void {
  if (!fs.existsSync(CLI_ANCHOR) || !fs.existsSync(CLI_BIN)) {
    throw new LaunchError(
      'LEPI_CLI_MISSING',
      "repository dsh install absent; run 'make install-profile'",
    );
  }
  const cliVersion = readJson<Manifest>(CLI_ANCHOR).version;
  if (cliVersion !== DSH_VERSION) {
    throw new LaunchError(
      'LEPI_CLI_VERSION_MISMATCH',
      `locked CLI is ${cliVersion}, expected ${DSH_VERSION}`,
    );
  }
  const pluginPkg = readJson<Manifest>(path.join(PLUGIN_DIR, 'package.json'));
  const peer = pluginPkg.peerDependencies?.['@deepseek-ai/dsh'];
  if (peer !== DSH_VERSION) {
    throw new LaunchError(
      'LEPI_CORE_VERSION_MISMATCH',
      `plugin peer @deepseek-ai/dsh is ${peer ?? 'unset'}, expected ${DSH_VERSION}`,
    );
  }
  for (const name of PLUGIN_HELPER_DEPS) {
    const dep = pluginPkg.dependencies?.[name];
    if (dep !== DSH_VERSION) {
      throw new LaunchError(
        'LEPI_CORE_VERSION_MISMATCH',
        `plugin dependency ${name} is ${dep ?? 'unset'}, expected ${DSH_VERSION}`,
      );
    }
    const installed = (
      createRequire(path.join(PLUGIN_DIR, 'package.json'))(`${name}/package.json`) as Manifest
    ).version;
    if (installed !== DSH_VERSION) {
      throw new LaunchError(
        'LEPI_CORE_VERSION_MISMATCH',
        `installed ${name} is not ${DSH_VERSION}`,
      );
    }
  }
}

/** `dev` requires the new entrypoint, not just independently built modules. */
async function assertCoreReady(): Promise<void> {
  const missing = CORE_MODULES.filter((m) => !fs.existsSync(path.join(PLUGIN_DIR, 'lib', m)));
  if (missing.length > 0)
    throw new LaunchError('LEPI_CORE_NOT_READY', 'new runtime cutover has not completed');
  // Static import cannot work here: the target is a generated artifact whose path is built at runtime,
  // and `dev` must fail closed when the lib/ cutover is absent — so it is only loaded once the gate passes.
  const entry = (await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href)) as {
    RUNTIME_CONTRACT?: unknown;
  };
  if (entry.RUNTIME_CONTRACT !== 1) {
    throw new LaunchError(
      'LEPI_CORE_NOT_READY',
      'entrypoint does not implement the approved runtime contract',
    );
  }
}

// ── config resolution ────────────────────────────────────────────────
function loadResolvedConfig(): LepiConfig {
  const load = loadEnvFile({ env: process.env, migrate: true });
  if (load.migrated) {
    info(`migrated legacy .env; backup written to ${load.backupPath}`);
  }
  for (const field of load.missingFields) {
    info(`missing ${field}: add it to ${load.file}; no endpoint is guessed`);
  }
  let cfg: LepiConfig;
  try {
    cfg = resolveConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new LaunchError(error.code, error.field ? `field ${error.field}` : null);
    }
    throw error;
  }
  return cfg;
}

// ── profile generation ───────────────────────────────────────────────
function profilePaths(dshHome: string): ProfilePaths {
  const dir = path.join(dshHome, 'profiles', PROFILE_NAME);
  return {
    dir,
    patch: path.join(dir, 'cordis.patch.yml'),
    pkg: path.join(dir, 'package.json'),
    nodeModules: path.join(dir, 'node_modules'),
    symlink: path.join(dir, 'node_modules', '@dsh-external', 'dsh-lepimemory-state'),
    marker: path.join(dir, GENERATED_MARKER),
  };
}

function isGeneratedProfile(paths: ProfilePaths): boolean {
  if (!fs.existsSync(paths.marker)) return false;
  try {
    return readJson<{ creator?: unknown }>(paths.marker).creator === MARKER_CREATOR;
  } catch {
    return false;
  }
}

/**
 * Refuse to touch a profile we did not generate, and never touch sibling
 * profiles. Returns "absent", "empty", or "ours".
 */
function inspectProfileOwnership(paths: ProfilePaths): 'absent' | 'empty' | 'ours' {
  if (!fs.existsSync(paths.dir)) return 'absent';
  if (isGeneratedProfile(paths)) return 'ours';
  const entries = fs.readdirSync(paths.dir);
  if (entries.length === 0) return 'empty';
  throw new LaunchError(
    'LEPI_PROFILE_CONFLICT',
    `${paths.dir} exists but was not generated by this launcher; refusing to overwrite`,
  );
}

/**
 * Force `fetch: false` on the profile preset's tool-web row. The preset lives in
 * config (not as a rooted entry-list row), so it cannot be patched by id; the
 * source patch text is transformed as we copy it. Fails loud if the shape moves.
 */
function forceToolWebFetchFalse(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\s*-\s*id:\s*tool-web\s*$/.test(line)) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const candidate = lines[j] ?? '';
      if (/^\s*-\s*id:/.test(candidate)) break;
      const m = candidate.match(/^(\s*)fetch:\s*(?:true|false)\s*$/);
      if (m) {
        lines[j] = `${m[1]}fetch: false`;
        return lines.join('\n');
      }
    }
    throw new LaunchError('LEPI_PROFILE_SHAPE', 'tool-web fetch config not found beside its id');
  }
  throw new LaunchError('LEPI_PROFILE_SHAPE', 'tool-web row not found in the source profile patch');
}

function providerEntry(routeKey: string, displayName: string, route: LlmRoute): string {
  // The verified DeepSeek baseline otherwise spends the whole bounded output on thinking.
  // Use native pi-ai compatibility metadata only on the fixed processing routes; leave role/UI models alone.
  const boundedDeepSeek = routeKey !== 'lepimemory-role' && route.model === 'deepseek-flash';
  return [
    `      ${routeKey}:`,
    `        displayName: ${yamlStr(displayName)}`,
    `        apiKeyEnv: ${yamlStr(route.apiKeyEnv)}`,
    `        api: openai-completions`,
    `        baseURL: ${yamlStr(route.baseUrl)}`,
    ...(boundedDeepSeek ? ['        reasoning: "off"'] : []),
    `        models:`,
    `          - id: ${yamlStr(route.model)}`,
    `            name: ${yamlStr(route.model)}`,
    ...(boundedDeepSeek
      ? [
          '            reasoningEfforts:',
          '              "off": null',
          '              high: high',
          '            compat:',
          '              thinkingFormat: deepseek',
          '              supportsReasoningEffort: false',
          '              supportsDeveloperRole: false',
        ]
      : []),
  ].join('\n');
}

/**
 * Generated overlay entries, appended to the copied profile patch so the profile
 * file alone is the composed config (no extra --patch overlay to forget).
 *
 * Credentials are referenced only by `apiKeyEnv` name; the values ride the child
 * env from derivedEnv(). When the shared connection is unconfigured we emit an
 * empty provider dict: that both refuses a custom route and neutralises the
 * draft profile's stale official-URL fallback, so no stock model escapes.
 */
function generateOverlayEntries(cfg: LepiConfig): string {
  const blocks: string[] = [];
  if (cfg.configured) {
    const routeEntries: Array<[string, string, LlmRoute]> = [
      ['lepimemory-role', 'Lepimemory 角色', cfg.llm.role],
      ['lepimemory-process', 'Lepimemory 处理', cfg.llm.process],
      ['lepimemory-control-fallback', 'Lepimemory 备用控制', cfg.llm.controlFallback],
    ];
    const providers = routeEntries
      .filter(([, , route]) => route.configured)
      .map(([id, name, route]) => providerEntry(id, name, route))
      .join('\n');
    blocks.push(
      [
        '- id: llm-pi-ai',
        `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
        '  config:',
        '    providers:',
        providers,
      ].join('\n'),
    );
    blocks.push(
      [
        '- id: agent-default-model',
        `  name: "@deepseek-ai/dsh-agent-default-model"`,
        '  config:',
        '    provider: "lepimemory-role"',
        `    model: ${yamlStr(cfg.llm.role.model)}`,
      ].join('\n'),
    );
  } else {
    blocks.push(
      [
        '- id: llm-pi-ai',
        `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
        '  config:',
        '    providers: {}',
      ].join('\n'),
    );
  }
  // Keep web search, drop raw page fetching.
  blocks.push(
    [
      '- id: tool-web',
      `  name: "@deepseek-ai/dsh-tool-web"`,
      '  config:',
      '    fetch: false',
      '    searchTimeoutMs: 60000',
    ].join('\n'),
  );
  // Block extra cross-session / local-file expansion surfaces.
  blocks.push(
    [
      '- id: session-reference',
      `  name: "@deepseek-ai/dsh-session-reference"`,
      '  disabled: true',
    ].join('\n'),
  );
  blocks.push(
    [
      '- id: file-reference-local',
      `  name: "@deepseek-ai/dsh-file-reference-local"`,
      '  disabled: true',
    ].join('\n'),
  );
  return blocks.join('\n');
}

function generateProfilePatch(cfg: LepiConfig): string {
  if (!fs.existsSync(PROFILE_PATCH_SRC)) {
    throw new LaunchError('LEPI_PROFILE_SOURCE_MISSING', `${PROFILE_PATCH_SRC} not found`);
  }
  const source = fs.readFileSync(PROFILE_PATCH_SRC, 'utf8');
  const preserved = forceToolWebFetchFalse(source);
  const header = [
    '# Generated by scripts/runtime.mjs from dsh/profiles/lepimemory — do not edit.',
    '# Persona and compaction live in the copied source patch; the entries below',
    '# override the connection/refs and neutralise the draft official-URL fallback.',
  ].join('\n');
  return `${preserved.replace(/\s*$/, '')}\n\n${header}\n${generateOverlayEntries(cfg)}\n`;
}

function generateProfilePackage(): string {
  const pkg = {
    name: 'dsh-profile-lepimemory',
    private: true,
    dependencies: {
      '@dsh-external/dsh-lepimemory-state': `link:${PLUGIN_DIR}`,
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@dsh-external/dsh-lepimemory-state',
        ],
      },
    },
  };
  return `${JSON.stringify(pkg, null, 4)}\n`;
}

/** Copy the profile and (re)generate ours. Idempotent once the marker exists. */
function ensureProfile(cfg: LepiConfig): ProfilePaths {
  const paths = profilePaths(cfg.home.dshHome);
  const ownership = inspectProfileOwnership(paths);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.nodeModules, { recursive: true });

  // Source files preserved verbatim (persona/compaction live in the patch).
  for (const name of ['cordis.yml', 'pnpm-workspace.yaml']) {
    const from = path.join(PROFILE_SRC, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(paths.dir, name));
    }
  }

  writeFileAtomic(paths.patch, generateProfilePatch(cfg));
  writeFileAtomic(paths.pkg, generateProfilePackage());

  // Absolute plugin link, replaced only for a profile we generated.
  if (ownership === 'ours' || ownership === 'absent' || ownership === 'empty') {
    fs.mkdirSync(path.dirname(paths.symlink), { recursive: true });
    fs.rmSync(paths.symlink, { recursive: true, force: true });
    fs.symlinkSync(PLUGIN_DIR, paths.symlink, 'dir');
  }

  writeFileAtomic(
    paths.marker,
    `${JSON.stringify(
      {
        creator: MARKER_CREATOR,
        schema: 1,
        pluginDir: PLUGIN_DIR,
        generatedAt: new Date().toISOString(),
      },
      null,
      4,
    )}\n`,
  );

  if (ownership !== 'ours') {
    info(`generated runtime profile at ${paths.dir}`);
  }
  return paths;
}

// ── external services (non-fatal) ────────────────────────────────────
function dockerEnv(cfg: LepiConfig): Record<string, string> {
  const route = cfg.llm.hindsight;
  return {
    HINDSIGHT_API_LLM_PROVIDER: route.configured ? 'openai' : 'none',
    HINDSIGHT_API_LLM_BASE_URL: route.baseUrl,
    HINDSIGHT_API_LLM_MODEL: route.model,
    HINDSIGHT_API_LLM_API_KEY: route.apiKey,
    HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: cfg.retrieval.embeddingsLocalModel,
    HINDSIGHT_API_RERANKER_LOCAL_MODEL: cfg.retrieval.rerankerLocalModel,
    HF_ENDPOINT: cfg.retrieval.hfEndpoint,
    LEPI_LAYA_URL: cfg.services.laya.url,
    LEPI_LAYA_API_KEY: cfg.services.laya.apiKey,
  };
}

/** Derived env injected into the child: names + values in memory only, never files. */
function runtimeEnv(cfg: LepiConfig): Record<string, string> {
  const env: Record<string, string> = {};
  applyDerivedEnv(env, cfg); // LEPI_*_API_KEY
  env.LEPI_HINDSIGHT_URL = cfg.services.hindsight.url;
  env.LEPI_LAYA_URL = cfg.services.laya.url;
  env.LEPI_LAYA_API_KEY = cfg.services.laya.apiKey;
  env.LEPI_BANK = cfg.bank;
  env.LEPI_ADMISSION_BACKEND = cfg.admissionBackend;
  env.LEPI_TIME_ZONE = cfg.timeZone;
  return env;
}

function startExternalServices(cfg: LepiConfig): void {
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    warn('docker compose unavailable; memory services were not started (external dependency)');
    return;
  }
  const child = spawn('docker', ['compose', '--progress', 'plain', 'up', '-d', '--build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...dockerEnv(cfg) },
  });
  child.on('error', () => warn('docker compose unavailable; core UI remains usable'));
  child.on('exit', (code) => {
    if (code !== 0) warn('memory service startup failed; core UI and task status remain available');
  });
}

// ── fixed CLI launch + core health ───────────────────────────────────
function launchCli(cfg: LepiConfig): ChildProcess {
  if (!fs.existsSync(CLI_BIN)) {
    throw new LaunchError(
      'LEPI_CLI_MISSING',
      "repository dsh install absent; run 'make install-profile'",
    );
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...runtimeEnv(cfg) };
  childEnv.DSH_HOME = cfg.home.dshHome;
  childEnv.PORT = String(cfg.home.port);
  const args = [
    '--expose-internals',
    CLI_BIN,
    '--profile',
    PROFILE_NAME,
    '--no-open',
    '--port',
    String(cfg.home.port),
  ];
  info(`launching locked dsh ${DSH_VERSION} (profile ${PROFILE_NAME}, port ${cfg.home.port})`);
  return spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit', env: childEnv });
}

async function waitForCoreHealth(port: number, child: ChildProcess): Promise<void> {
  const url = `http://127.0.0.1:${port}/lepimemory/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new LaunchError('LEPI_DEV_FAILED', `dsh exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { core?: unknown } | null;
        if (body && body.core === true) return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEALTH_INTERVAL_MS);
    });
  }
  throw new LaunchError('LEPI_CORE_NOT_READY', `core health did not become ready at ${url}`);
}

// ── commands ─────────────────────────────────────────────────────────
function commandInstall(): void {
  assertPinnedNode();
  const cfg = loadResolvedConfig();
  assertInstallation();
  ensureProfile(cfg);
  if (process.env.LEPI_RUNTIME_DEBUG === '1') {
    info(`resolved config: ${JSON.stringify(redactConfig(cfg))}`);
  }
  info(`install complete (home ${cfg.home.dshHome}, bank ${cfg.bank})`);
}

async function commandDev(): Promise<void> {
  assertPinnedNode();
  const cfg = loadResolvedConfig();
  assertInstallation();
  await assertCoreReady(); // fail closed before any launch
  ensureProfile(cfg);
  startExternalServices(cfg);
  const child = launchCli(cfg);
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  try {
    await waitForCoreHealth(cfg.home.port, child);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
  info(`core ready; open the authenticated link printed by dsh (303 clears the token)`);
  child.on('exit', (code) => process.exit(code ?? 0));
}

function runEntry(file: string, flags: string[] = []): void {
  if (!fs.existsSync(file)) {
    throw new LaunchError(
      'LEPI_VERIFY_MISSING',
      `${file} not present (added at the Step-11 cutover)`,
    );
  }
  const result = spawnSync(process.execPath, [...flags, file], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new LaunchError(
      'LEPI_VERIFY_FAILED',
      `${path.relative(REPO_ROOT, file)} exited ${result.status}`,
    );
  }
}

function commandVerify(): void {
  assertPinnedNode();
  runEntry(path.join(REPO_ROOT, 'scripts', 'dist', 'verify-runtime.js'));
  runEntry(path.join(PLUGIN_DIR, 'test', 'runtime.test.js'), [
    '--test',
    path.join(PLUGIN_DIR, 'test', 'recall.test.js'),
    path.join(PLUGIN_DIR, 'test', 'history.test.js'),
    path.join(PLUGIN_DIR, 'test', 'action.test.js'),
    path.join(PLUGIN_DIR, 'test', 'avatar.test.js'),
    path.join(PLUGIN_DIR, 'test', 'panel-groups.test.js'),
  ]);
  info('verify passed');
}

function usage(): void {
  process.stderr.write('usage: runtime.mjs <install|dev|verify>\n');
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  switch (command) {
    case 'install':
      commandInstall();
      break;
    case 'dev':
      await commandDev();
      break;
    case 'verify':
      commandVerify();
      break;
    default:
      usage();
      process.exit(2);
  }
}

async function run(): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LaunchError) {
      process.stderr.write(`lepimemory-runtime: ${error.message}\n`);
      process.exit(1);
    }
    if (error instanceof ConfigError) {
      process.stderr.write(
        `lepimemory-runtime: ${error.code}${error.field ? ` [${error.field}]` : ''}\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      `lepimemory-runtime: unexpected error: ${(error as Error)?.stack ?? String(error)}\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) await run();

export {
  run,
  commandInstall,
  commandDev,
  commandVerify,
  ensureProfile,
  generateProfilePatch,
  forceToolWebFetchFalse,
  LaunchError,
};
