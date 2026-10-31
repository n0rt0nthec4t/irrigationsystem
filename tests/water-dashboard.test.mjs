// Regression coverage for pulse accounting and dashboard freshness without GPIO hardware.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function loadClass(file, name, context, replacements = []) {
  let source = fs
    .readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export default class', 'class');
  for (const [before, after] of replacements) {
    source = source.replace(before, after);
  }
  vm.runInContext(source + '\nglobalThis.Subject = ' + name + ';', context);
  return context.Subject;
}

test('flow volume preserves short bursts and varying sampling intervals', () => {
  let now = 100000;
  let pulse;
  let processFlow;
  const events = [];
  const context = vm.createContext({
    Date: { now: () => now },
    performance: { now: () => now },
    crypto: { randomUUID: () => 'sensor' },
    LOG_LEVELS: {},
    validGPIOPin: () => true,
    HomeKitDevice: {
      message: (_uuid, type, value) => {
        if (type === 'FLOWEVENT') {
          events.push(value);
        }
      },
    },
    setInterval: (callback) => {
      processFlow = callback;
      return 1;
    },
    clearInterval: () => {},
  });
  const Sensor = loadClass('src/flowsensor.js', 'FlowSensor', context);
  Sensor.GPIO = {
    open: () => {},
    poll: (_pin, callback) => {
      pulse = callback;
    },
  };
  const sensor = new Sensor(undefined, 'device', { sensorPin: 1, flowRate: 0.964 });
  for (let i = 0; i < 3; i++) {
    now += 1000;
    processFlow();
  }
  for (let i = 0; i < 30; i++) {
    now += 25;
    pulse();
  }
  now += 250;
  processFlow();
  assert.ok(Math.abs(events.at(-1).volume - (30 * 0.964) / 60) < 1e-12);
  now += 2000;
  pulse();
  processFlow();
  assert.ok(Math.abs(events.at(-1).volume - 0.964 / 60) < 1e-12);
  now += 1000;
  processFlow();
  assert.equal(events.at(-1).volume, 0);
  assert.ok(Math.abs(events.reduce((sum, event) => sum + event.volume, 0) - (31 * 0.964) / 60) < 1e-12);
  sensor.onShutdown();
});

function dashboard(tank, history = [], zones = []) {
  class Device {
    hap = { Service: { Valve: { UUID: 'valve' } } };
    historyService = { getHistory: () => history, lastHistory: () => history.at(-1) };
    deviceData = { zones, tanks: [{ uuid: 'tank', name: 'Rainwater', capacity: 5000, enabled: true }] };
  }
  const context = vm.createContext({
    HomeKitDevice: Device,
    GPIO: { init: () => {} },
    WaterTank: {},
    Valve: {},
    FlowSensor: {},
    fixtureTank: tank,
  });
  const System = loadClass('src/system.js', 'IrrigationSystem', context, [
    ['#tanks = {};', '#tanks = { tank: fixtureTank };'],
    ['#zones = {};', '#zones = { zone: { service: { subtype: 1 } } };'],
  ]);
  return new System().getDashboard();
}

test('tank dashboard distinguishes unavailable, empty, and stale readings', () => {
  assert.match(dashboard(undefined).html, /No reading/);
  assert.doesNotMatch(dashboard(undefined).html, />Empty</);
  assert.match(dashboard({ percentage: 0, lastUpdated: Date.now() }).html, />Empty</);
  const stale = dashboard({ percentage: 42.49, lastUpdated: Date.now() - 360000 }).html;
  assert.match(stale, /Stale reading/);
  assert.match(stale, /2,125 L/);
  assert.match(stale, /42%/);
});

test('zero-use days have zero bar heights', () => {
  const result = dashboard(undefined);
  assert.match(result.html, /0 L on .*?height:0%/);
  assert.doesNotMatch(result.html, /height:6%/);
  assert.match(result.html, /Completed zone runs per day/);
  assert.match(result.css, /min-height: 0;/);
});

test('usage preserves fractions and totals completed runs only', () => {
  const result = dashboard(undefined, [
    { status: 0, water: 33.5, time: Math.floor(Date.now() / 1000) },
    { status: 0, water: 0.5, time: Math.floor(Date.now() / 1000) },
    { status: 1, water: 99, time: Math.floor(Date.now() / 1000) },
  ]);
  assert.match(result.html, /Total \(30 days\)<\/div><div class="dashboard-usage-footer-value">34 L/);
  assert.match(result.html, /Daily average<\/div><div class="dashboard-usage-footer-value">1.13 L/);
});

test('zone estimates use the latest measured run instead of averaging old low readings', () => {
  const time = Math.floor(Date.now() / 1000);
  const history = [
    ...Array.from({ length: 4 }, () => ({ status: 0, water: 66.25, duration: 3600, time: time - 86400 })),
    { status: 0, water: 1200, duration: 3600, time },
  ];
  const zones = [{ uuid: 'zone', name: 'Front Lawn', runtime: 3600 }];
  const result = dashboard(undefined, history, zones);
  assert.match(result.html, /20.0 L\/min/);
  assert.match(result.html, /Est. 1,200 L/);
  assert.doesNotMatch(result.html, /Est. 293 L/);

  // Runtime changes should scale the measured rate, not repeat the last total.
  assert.match(dashboard(undefined, history, [{ ...zones[0], runtime: 1800 }]).html, /Est. 600 L/);
});

test('zone estimates skip starts and unusable measurements and handle missing history', () => {
  const time = Math.floor(Date.now() / 1000);
  const zones = [{ uuid: 'zone', name: 'Front Lawn', runtime: 3600 }];
  const invalidEntries = [
    { status: 0, water: 0, duration: 3600, time },
    { status: 0, water: 1200, duration: 0, time },
    { status: 0, water: 'invalid', duration: 3600, time },
    { status: 0, water: 1200, duration: 'invalid', time },
    { status: 1, water: 0, duration: 0, time },
  ];
  assert.match(
    dashboard(undefined, [{ status: 0, water: 1200, duration: 3600, time }, ...invalidEntries], zones).html,
    /Est. 1,200 L/,
  );
  assert.match(dashboard(undefined, invalidEntries, zones).html, /No estimate/);
  assert.match(dashboard(undefined, [], zones).html, /No estimate/);
});

test('dashboard refresh resumes after select interaction while text edits remain protected', async () => {
  let now = 100000;
  let timer;
  let loads = 0;
  const handlers = {};
  const activeElement = { tagName: 'SELECT', closest: () => activeElement };
  const context = vm.createContext({
    Date: { now: () => now },
    document: {
      title: 'test',
      activeElement,
      addEventListener: (type, callback) => {
        (handlers[type] ??= []).push(callback);
      },
      querySelectorAll: () => [],
    },
    window: {
      location: { hash: '#dashboard' },
      addEventListener: () => {},
      setInterval: (callback) => {
        timer = callback;
        return 1;
      },
    },
  });
  let source = fs.readFileSync('src/HomeKitUI/ui/app.js', 'utf8').replace('// Start UI\nload();\nstartRuntimeTimer();', '');
  vm.runInContext(source, context);
  vm.runInContext(
    'state.info = { pages: [{ id: \'dashboard\', refreshInterval: 1000 }] }; lastStatusPoll = Date.now(); ' +
      'loadPageData = async () => { recordLoad(); }; scheduleRender = () => {}; startRuntimeTimer();',
    Object.assign(context, {
      recordLoad: () => {
        loads++;
      },
    }),
  );
  handlers.pointerdown[0]({ target: activeElement, pointerId: 1 });
  handlers.pointerup[0]({ pointerId: 1 });
  await timer();
  assert.equal(loads, 0);
  now += 5000;
  await timer();
  assert.equal(loads, 1);
  activeElement.tagName = 'INPUT';
  now += 1000;
  await timer();
  assert.equal(loads, 1);
  activeElement.tagName = 'BUTTON';
  now += 1000;
  await timer();
  assert.equal(loads, 2);
});
