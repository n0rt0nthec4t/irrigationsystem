// Exercise the built controller with real HAP services and mocked GPIO/timers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import HAP from '@homebridge/hap-nodejs';
import GPIO from 'rpio';
import IrrigationSystem from '../dist/system.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';
import HomeKitHistory from '../dist/HomeKitHistory.js';
import { validGPIOPin } from '../dist/utils.js';

HomeKitDevice.PLUGIN_NAME = 'irrigation-regression';
HomeKitDevice.PLATFORM_NAME = 'irrigation-regression';
let serial = 0;

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => Date.now());
  const pins = new Map();
  const polls = new Map();
  t.mock.method(GPIO, 'init', () => {});
  t.mock.method(GPIO, 'open', (pin, mode, value) => {
    if (mode === GPIO.OUTPUT) {
      pins.set(pin, value);
    }
  });
  t.mock.method(GPIO, 'write', (pin, value) => pins.set(pin, value));
  t.mock.method(GPIO, 'poll', (pin, callback) => polls.set(pin, callback));
  const system = new IrrigationSystem(undefined, HAP, {
    serialNumber: 'control-test-' + ++serial,
    softwareVersion: '0.0.7',
    description: 'Irrigation System',
    model: 'Irrigation',
    manufacturer: 'test',
    hkPairingCode: '031-45-154',
    hkUsername: 'AA:BB:CC:DD:EE:FF',
    power: true,
    pauseTimeout: 0,
    maxRuntime: 7200,
    tanks: [],
    zones: [{ uuid: 'zone', name: 'Zone', enabled: true, runtime: 10, relayPin: 20 }],
    ...options,
  });
  system.accessory = new HAP.Accessory('Test', system.uuid);
  const history = [];
  system.historyService = { addHistory: (target, entry) => history.push({ target, entry: { ...entry } }) };
  system.onAdd();
  t.after(async () => {
    await system.message(HomeKitDevice.SHUTDOWN);
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return { system, pins, polls, history, zone: system.deviceData.zones[0], service: system.accessory.getService(HAP.Service.Valve) };
}

async function settle() {
  // Lifecycle dispatch awaits hooks; finish those continuations before assertions.
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
}

test('an old stop fallback cannot cancel a restarted run or its deadline', async (t) => {
  const f = fixture(t);
  f.system.setZoneActive(f.zone, true);
  f.system.setZoneActive(f.zone, false);
  await settle();
  f.system.setZoneActive(f.zone, true);
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(f.pins.get(20), GPIO.HIGH);
  assert.equal(f.service.getCharacteristic(HAP.Characteristic.Active).value, HAP.Characteristic.Active.ACTIVE);
  t.mock.timers.tick(8000);
  await settle();
  assert.equal(f.pins.get(20), GPIO.LOW);
  assert.equal(f.service.getCharacteristic(HAP.Characteristic.Active).value, HAP.Characteristic.Active.INACTIVE);
});

test('a rejected powered-off start cannot clear a later accepted run', async (t) => {
  const f = fixture(t, { power: false });
  f.system.setZoneActive(f.zone, true);
  f.system.setPower(true);
  f.system.setZoneActive(f.zone, true);
  t.mock.timers.tick(500);
  await settle();
  assert.equal(f.service.getCharacteristic(HAP.Characteristic.Active).value, HAP.Characteristic.Active.ACTIVE);
  t.mock.timers.tick(9500);
  await settle();
  assert.equal(f.pins.get(20), GPIO.LOW);
});

test('HomeKit callbacks use current config after replacement, including disabling', async (t) => {
  const f = fixture(t);
  await f.system.message(HomeKitDevice.UPDATE, { zones: [{ ...f.zone, name: 'Updated', runtime: 20 }] });
  assert.equal(await f.service.getCharacteristic(HAP.Characteristic.ConfiguredName).handleGetRequest(), 'Updated');
  assert.equal(await f.service.getCharacteristic(HAP.Characteristic.SetDuration).handleGetRequest(), 20);
  await f.service.getCharacteristic(HAP.Characteristic.ConfiguredName).handleSetRequest('Renamed');
  await f.service.getCharacteristic(HAP.Characteristic.SetDuration).handleSetRequest(30);
  await f.service.getCharacteristic(HAP.Characteristic.IsConfigured).handleSetRequest(HAP.Characteristic.IsConfigured.NOT_CONFIGURED);
  await settle();
  assert.equal(f.system.deviceData.zones[0].name, 'Renamed');
  assert.equal(f.system.deviceData.zones[0].runtime, 30);
  assert.equal(f.system.deviceData.zones[0].enabled, false);
  f.system.setZoneActive(f.zone, true);
  assert.equal(f.pins.get(20), GPIO.LOW);
});

test('pending pulses are saved at stop and cannot move into the next run', async (t) => {
  const f = fixture(t, { sensorFlowPin: 18, flowRate: 1 });
  f.system.setZoneActive(f.zone, true);
  for (let index = 0; index < 10; index++) {
    t.mock.timers.tick(25);
    f.polls.get(18)(18);
  }
  f.system.setZoneActive(f.zone, false);
  await settle();
  const completed = f.history.filter((sample) => sample.entry.status === 0);
  assert.equal(completed.length, 1);
  assert.ok(Math.abs(completed[0].entry.water - 10 / 60) < 1e-12);
  f.system.setZoneActive(f.zone, true);
  t.mock.timers.tick(1000);
  f.system.setZoneActive(f.zone, false);
  await settle();
  assert.equal(f.history.filter((sample) => sample.entry.status === 0).at(-1).entry.water, 0);
});

test('final sampling includes pulses consumed in the same millisecond as a sensor tick', async (t) => {
  const f = fixture(t, { sensorFlowPin: 18, flowRate: 1 });
  f.system.setZoneActive(f.zone, true);
  t.mock.timers.tick(1000);
  f.polls.get(18)(18);
  f.system.setZoneActive(f.zone, false);
  await settle();
  assert.ok(Math.abs(f.history.find((sample) => sample.entry.status === 0).entry.water - 1 / 60) < 1e-12);
});

test('empty and invalid relay layouts cannot drive GPIO zero', (t) => {
  const f = fixture(t, { zones: [{ uuid: 'zone', name: 'Zone', enabled: true, runtime: 10, relayPin: [] }] });
  f.system.setZoneActive(f.zone, true);
  assert.equal(f.pins.has(0), false);
  for (const value of [null, undefined, '', ' ', [], [20], {}, 20.5]) {
    assert.equal(validGPIOPin(value), false);
  }
  assert.equal(validGPIOPin(0), true);
  assert.equal(validGPIOPin('20'), true);
});

test('tank samples are recorded under the WaterLevel characteristic', async (t) => {
  const f = fixture(t, { tanks: [{ uuid: 'tank', name: 'Tank', enabled: false, capacity: 5000 }] });
  // Enable a tank with invalid dimensions to create its entry without GPIO sampling.
  await f.system.message(HomeKitDevice.UPDATE, {
    tanks: [{ uuid: 'tank', name: 'Tank', enabled: true, capacity: 5000, sensorTrigPin: 21, sensorEchoPin: 22, sensorHeight: 0 }],
  });
  const stored = new Map();
  const history = new HomeKitHistory(f.system.accessory, {
    ...HAP,
    HAPStorage: {
      storage: () => ({
        getItem: (key) => stored.get(key),
        setItemSync: (key, value) => stored.set(key, structuredClone(value)),
      }),
    },
  });
  f.system.historyService = history;
  await f.system.onMessage('WATERLEVEL', { uuid: 'tank', percentage: 50, waterlevel: 1000 });
  await settle();
  assert.equal(history.getHistory(HAP.Characteristic.WaterLevel)[0].level, 50);
  assert.equal([...stored.values()][0].data[0].level, 50);
});

test('a failed relay close retains runtime supervision until a retry succeeds', async (t) => {
  const f = fixture(t);
  const write = GPIO.write;
  let failClose = true;
  t.mock.method(GPIO, 'write', (pin, value) => {
    if (value === GPIO.LOW && failClose === true) {
      throw new Error('GPIO failure');
    }
    return write(pin, value);
  });
  f.system.setZoneActive(f.zone, true);
  f.system.setZoneActive(f.zone, false);
  assert.equal(f.pins.get(20), GPIO.HIGH);
  assert.equal(f.service.getCharacteristic(HAP.Characteristic.Active).value, HAP.Characteristic.Active.ACTIVE);
  failClose = false;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(f.pins.get(20), GPIO.LOW);
  assert.equal(f.service.getCharacteristic(HAP.Characteristic.Active).value, HAP.Characteristic.Active.INACTIVE);
});

test('switching zones assigns each boundary sample to its originating run', async (t) => {
  const f = fixture(t, {
    sensorFlowPin: 18,
    flowRate: 1,
    zones: [
      { uuid: 'zone', name: 'First', enabled: true, runtime: 10, relayPin: 20 },
      { uuid: 'next', name: 'Second', enabled: true, runtime: 10, relayPin: 21 },
    ],
  });
  f.system.setZoneActive(f.zone, true);
  for (let index = 0; index < 5; index++) {
    t.mock.timers.tick(25);
    f.polls.get(18)(18);
  }
  f.system.setZoneActive(f.system.deviceData.zones[1], true);
  for (let index = 0; index < 10; index++) {
    t.mock.timers.tick(25);
    f.polls.get(18)(18);
  }
  f.system.setZoneActive(f.system.deviceData.zones[1], false);
  await settle();
  const completed = f.history.filter((sample) => sample.entry.status === 0);
  assert.equal(completed.length, 2);
  assert.ok(Math.abs(completed[0].entry.water - 5 / 60) < 1e-12);
  assert.ok(Math.abs(completed[1].entry.water - 10 / 60) < 1e-12);
});

test('a second zone cannot open while the preceding zone fails to close', async (t) => {
  const f = fixture(t, {
    zones: [
      { uuid: 'zone', name: 'First', enabled: true, runtime: 10, relayPin: 20 },
      { uuid: 'next', name: 'Second', enabled: true, runtime: 10, relayPin: 21 },
    ],
  });
  const write = GPIO.write;
  let failClose = true;
  t.mock.method(GPIO, 'write', (pin, value) => {
    if (pin === 20 && value === GPIO.LOW && failClose === true) {
      throw new Error('GPIO failure');
    }
    return write(pin, value);
  });
  f.system.setZoneActive(f.zone, true);
  f.system.setZoneActive(f.system.deviceData.zones[1], true);
  assert.equal(f.pins.get(20), GPIO.HIGH);
  assert.equal(f.pins.get(21), GPIO.LOW);
  failClose = false;
  t.mock.timers.tick(1000);
  await settle();
  f.system.setZoneActive(f.system.deviceData.zones[1], true);
  assert.equal(f.pins.get(20), GPIO.LOW);
  assert.equal(f.pins.get(21), GPIO.HIGH);
});
