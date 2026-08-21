#!/usr/bin/env node
/**
 * Phase 1 gate for the LiveKit voice engine, as one runnable command.
 *
 *   node scripts/livekit-spike.mjs
 *
 * Proves, end to end and with no microphone and no cloud account, that the
 * self-hosted path actually works on this machine:
 *
 *   1. the LiveKit server binary runs here
 *   2. it comes up bound to loopback only
 *   3. an Agents worker registers against it
 *   4. a dispatch reaches that worker
 *   5. the agent joins the room over WebRTC and shows up as a live participant
 *
 * Step 5 is the one that matters. Steps 1-4 are HTTP and a websocket, and they
 * passed on the first try; the ICE handshake in step 5 did not, and the reason
 * it did not is now encoded in `serverConfig()` below. A spike that only
 * proved "the worker registered" would have reported success over a voice
 * engine that could never carry audio.
 *
 * Exits 0 when the whole chain works, 1 with the failing step named.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const LIVEKIT_VERSION = '1.13.5';
const HTTP_PORT = 7889; // not 7880: a real install may already be running
const RTC_TCP = 7891;
const RTC_UDP = [7893, 7903];
const KEY = 'cinderpaw-spike';
const SECRET = 'spikespikespikespikespikespikespike00';
const ROOM = 'cinderpaw-spike';
const AGENT = 'cinderpaw-spike-agent';

const root = join(tmpdir(), 'cinderpaw-livekit-spike');
const log = (...a) => console.log('[spike]', ...a);
const fail = (step, why) => {
  console.error(`\n[spike] FAILED at: ${step}\n[spike] ${why}`);
  process.exit(1);
};

/**
 * The config that took three tries.
 *
 * `bind_addresses: [127.0.0.1]` keeps the signalling port off the network. The
 * default binds every interface, and the first run of this spike put the RTC
 * port on a public IPv6 address and on the LAN address — for a desktop app
 * that is a listening socket on somebody's home network, which is not a thing
 * to ship by accident.
 *
 * `node_ip: 127.0.0.1` is what makes the media path work. Without it the agent
 * accepted the job and then died with `wait_pc_connection timed out`: the
 * server was advertising ICE candidates on an address the loopback-bound agent
 * could not reach.
 *
 * What does NOT work, and cost the second try: `rtc.interfaces.includes:
 * [loopback]`. It reads like the right way to say "local only" and it makes
 * ICE fail outright on Windows. Narrow the ADVERTISED address, not the
 * enumerated interfaces.
 */
const serverConfig = () => `
port: ${HTTP_PORT}
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: ${RTC_TCP}
  port_range_start: ${RTC_UDP[0]}
  port_range_end: ${RTC_UDP[1]}
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  ${KEY}: ${SECRET}
logging:
  level: info
`;

const AGENT_SRC = `
import { defineAgent, cli, WorkerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
export default defineAgent({
  entry: async (ctx) => { await ctx.connect(); console.log('SPIKE_AGENT_IN_ROOM'); },
});
cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: '${AGENT}',
  wsURL: 'ws://127.0.0.1:${HTTP_PORT}',
  apiKey: '${KEY}',
  apiSecret: '${SECRET}',
}));
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it returns truthy, or give up after `ms`. */
async function until(ms, check) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  return false;
}

async function main() {
  mkdirSync(root, { recursive: true });

  // ── 1. the binary ───────────────────────────────────────────────────────
  const platform = { win32: 'windows', linux: 'linux' }[process.platform];
  if (!platform) {
    // No darwin build is published — see docs/voice-livekit.md. Saying so is
    // the point: a mac dev running this should be told why, not watch a 404.
    fail(
      'resolving the server binary',
      `LiveKit publishes no ${process.platform} server build. See docs/voice-livekit.md.`,
    );
  }
  const exe = join(root, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  if (!existsSync(exe)) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const ext = platform === 'windows' ? 'zip' : 'tar.gz';
    const url = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_${platform}_${arch}.${ext}`;
    log('downloading', url);
    const archive = join(root, `livekit.${ext}`);
    const res = await fetch(url);
    if (!res.ok) fail('downloading the server binary', `${url} -> HTTP ${res.status}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const un =
      platform === 'windows'
        ? spawnSync('powershell', [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Force -Path '${archive}' -DestinationPath '${root}'`,
          ])
        : spawnSync('tar', ['xzf', archive, '-C', root]);
    if (un.status !== 0) fail('unpacking the server binary', String(un.stderr));
  }
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) fail('running the server binary', v.stderr || 'non-zero exit');
  log('binary ok:', v.stdout.trim());

  // ── 2. the server ───────────────────────────────────────────────────────
  const cfg = join(root, 'livekit.yaml');
  writeFileSync(cfg, serverConfig());
  const server = spawn(exe, ['--config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  const up = await until(
    30_000,
    async () => (await fetch(`http://127.0.0.1:${HTTP_PORT}`).catch(() => null))?.ok,
  );
  if (!up) {
    server.kill();
    fail('booting the server', serverLog.slice(-800));
  }
  log('server up on 127.0.0.1:' + HTTP_PORT);

  // ── 3. the worker ───────────────────────────────────────────────────────
  const agentFile = join(root, 'spike-agent.mjs');
  writeFileSync(agentFile, AGENT_SRC);
  if (!existsSync(join(root, 'node_modules', '@livekit', 'agents'))) {
    writeFileSync(join(root, 'package.json'), '{"name":"lk-spike","private":true,"type":"module"}');
    log('installing @livekit/agents (first run only)...');
    // `shell: true` because on Windows npm is a .cmd shim, and spawning it
    // directly fails with ENOENT — which arrives as `error`, not as a non-zero
    // `status` with stderr. Reporting only stderr printed "undefined" and said
    // nothing about what went wrong, so both are checked and both are shown.
    const npm = spawnSync(
      'npm',
      ['install', '--no-audit', '--no-fund', '@livekit/agents', 'livekit-server-sdk'],
      { cwd: root, encoding: 'utf8', shell: true },
    );
    if (npm.error || npm.status !== 0) {
      server.kill();
      fail('installing @livekit/agents', npm.error?.message ?? npm.stderr?.slice(-800) ?? 'unknown');
    }
  }
  const worker = spawn(process.execPath, [agentFile, 'dev'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let workerLog = '';
  worker.stdout.on('data', (d) => (workerLog += d));
  worker.stderr.on('data', (d) => (workerLog += d));
  const cleanup = () => {
    try {
      worker.kill();
    } catch {
      /* already gone */
    }
    try {
      server.kill();
    } catch {
      /* already gone */
    }
  };

  if (!(await until(60_000, () => workerLog.includes('registered worker')))) {
    cleanup();
    fail('registering the agent worker', workerLog.slice(-800));
  }
  log('worker registered');

  // ── 4 + 5. dispatch, and the media path ─────────────────────────────────
  const sdk = await import(
    pathToFileURL(join(root, 'node_modules', 'livekit-server-sdk', 'dist', 'index.js')).href
  );
  const url = `http://127.0.0.1:${HTTP_PORT}`;
  const rooms = new sdk.RoomServiceClient(url, KEY, SECRET);
  await rooms.createRoom({ name: ROOM });
  await new sdk.AgentDispatchClient(url, KEY, SECRET).createDispatch(ROOM, AGENT, {});
  log('dispatched');

  if (!(await until(30_000, () => workerLog.includes('SPIKE_AGENT_IN_ROOM')))) {
    const why = /reason: "([^"]+)"/.exec(workerLog)?.[1] ?? workerLog.slice(-800);
    cleanup();
    fail('the agent joining the room (ICE/media path)', why);
  }

  const live = await rooms.listParticipants(ROOM);
  cleanup();
  if (!live.length) {
    fail('confirming a live participant', 'the agent connected but the room lists nobody');
  }
  log('agent is live in the room:', live.map((p) => p.identity).join(', '));
  log('PASS - self-hosted LiveKit carries a call on this machine.');
}

main().catch((e) => fail('the spike itself', e?.stack ?? String(e)));
