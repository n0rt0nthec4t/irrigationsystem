// Exercise entrypoint signal registration, startup cancellation and ordered teardown
// with controlled device/UI promises, without GPIO or process termination.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

async function settle() {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
}

function fixture(options = {}) {
  const events = [];
  const exits = [];
  const errors = [];
  const process = new EventEmitter();
  process.exit = (code) => exits.push(code);
  const context = {
    process,
    log: { warn() {}, error: (...args) => errors.push(args) },
    HAP: { Categories: { SPRINKLER: 28 } },
    deviceData: {},
    config: { options: { webUIPort: 8080 } },
    version: '0.0.8',
    configurationFile: '/fake/config.json',
    CONFIG_SCHEMA_FILE: '/fake/schema.json',
    HomeKitDevice: { SET: 'set', message() {} },
    IrrigationSystem: class {
      constructor() {
        // Application listeners must exist before HomeKitDevice is constructed.
        assert.equal(process.listenerCount('SIGINT'), 1);
        assert.equal(process.listenerCount('SIGTERM'), 1);
        this.uuid = 'device';
        this.accessory = {};
        events.push('construct');
      }

      async add() {
        events.push('add');
        return options.add === undefined ? true : options.add();
      }

      async shutdown() {
        events.push('device stop');
        await options.deviceStop?.();
        events.push('device stopped');
      }
    },
    HomeKitUI: class {
      constructor(settings) {
        context.restart = settings.onRestart;
        events.push('UI construct');
      }

      async start() {
        events.push('UI start');
        await options.uiStart?.();
      }

      async stop() {
        events.push('UI stop');
        await options.uiStop?.();
        events.push('UI stopped');
      }
    },
  };
  const source = fs.readFileSync('dist/index.js', 'utf8');
  const runtime = source.slice(source.indexOf('// Runtime state shared'), source.indexOf('// Startup code'));
  const startup = source.slice(source.indexOf('try {\n  tempDevice = new'), source.indexOf('// Handle process shutdown'));
  const teardown = source.slice(source.indexOf('// Handle process shutdown'));
  assert.ok(runtime.length > 0 && startup.length > 0 && teardown.length > 0);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction(
    'context',
    'const { process, log, HAP, deviceData, config, version, configurationFile, CONFIG_SCHEMA_FILE, HomeKitDevice, ' +
      'IrrigationSystem, HomeKitUI } = context;\n' +
      runtime +
      '\ncontext.shutdown = shutdown;\n' +
      startup +
      teardown,
  );
  const started = run(context);
  return { context, events, exits, errors, process, started };
}

test('shutdown waits for the device and UI and ignores repeated requests', async () => {
  let finishDevice;
  let finishUI;
  const f = fixture({
    deviceStop: () =>
      new Promise((resolve) => {
        finishDevice = resolve;
      }),
    uiStop: () =>
      new Promise((resolve) => {
        finishUI = resolve;
      }),
  });
  await f.started;
  const stopping = f.context.shutdown('SIGTERM');
  await settle();
  assert.deepEqual(f.exits, []);
  assert.equal(f.events.includes('UI stop'), false);
  await f.context.shutdown('SIGINT');
  finishDevice();
  await settle();
  assert.equal(f.events.includes('UI stop'), true);
  assert.deepEqual(f.exits, []);
  finishUI();
  await stopping;
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.events.filter((event) => event === 'device stop').length, 1);
});

test('SIGINT and SIGTERM each use the application shutdown route', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = fixture();
    await f.started;
    f.process.emit(signal);
    await settle();
    assert.deepEqual(f.exits, [0]);
    assert.deepEqual(f.events.slice(-4), ['device stop', 'device stopped', 'UI stop', 'UI stopped']);
  }
});

test('device or UI teardown failures are logged and exit with failure after remaining cleanup', async () => {
  for (const failingStep of ['deviceStop', 'uiStop']) {
    const f = fixture({
      [failingStep]: async () => {
        throw new Error('Cleanup failed');
      },
    });
    await f.started;
    await f.context.shutdown('SIGTERM');
    assert.deepEqual(f.exits, [1]);
    assert.equal(f.events.includes('UI stop'), true);
    assert.equal(f.errors.length, 1);
  }
});

test('a signal during publication cancels startup and does not start the UI', async () => {
  let cancelAdd;
  const f = fixture({
    add: () =>
      new Promise((resolve) => {
        cancelAdd = resolve;
      }),
    deviceStop: () => {
      cancelAdd(false);
    },
  });
  f.process.emit('SIGTERM');
  await f.started;
  await settle();
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.events.includes('UI construct'), false);
  assert.deepEqual(f.errors, []);
});

test('startup failures clean up the owned device and exit with failure', async () => {
  for (const options of [
    { add: () => false },
    {
      uiStart: () => {
        throw new Error('Port busy');
      },
    },
  ]) {
    const f = fixture(options);
    await f.started;
    assert.deepEqual(f.exits, [1]);
    assert.equal(f.events.includes('device stopped'), true);
    assert.equal(f.errors.length, 1);
    if (options.uiStart !== undefined) {
      assert.equal(f.events.includes('UI stopped'), true);
    }
  }
});

test('Web UI restart awaits cleanup and requests the existing restart exit code', async () => {
  const f = fixture();
  await f.started;
  await f.context.restart();
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.events.slice(-4), ['device stop', 'device stopped', 'UI stop', 'UI stopped']);
});
