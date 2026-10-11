// Exercise the production startup call with real device/HAP classes, without publishing on the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import HAP from '@homebridge/hap-nodejs';
import GPIO from 'rpio';
import IrrigationSystem from '../dist/system.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';
import HomeKitHistory from '../dist/HomeKitHistory.js';

function fixture(t, failPublish = false) {
  HomeKitDevice.PLUGIN_NAME = 'irrigation-startup-test';
  HomeKitDevice.PLATFORM_NAME = 'irrigation-startup-test';
  HomeKitDevice.EVEHOME = HomeKitHistory;
  for (const method of ['init', 'open', 'write', 'poll']) {
    t.mock.method(GPIO, method, () => {});
  }
  const publications = [];
  t.mock.method(HAP.Accessory.prototype, 'publish', async function (options) {
    publications.push({ accessory: this, options });
    if (failPublish === true) {
      throw new Error('Publish failed');
    }
  });
  const stored = new Map();
  const api = {
    ...HAP,
    HAPStorage: {
      storage: () => ({
        getItem: (key) => stored.get(key),
        setItemSync: (key, value) => stored.set(key, structuredClone(value)),
      }),
    },
  };
  let device;
  class StartupSystem extends IrrigationSystem {
    constructor(...args) {
      super(...args);
      device = this;
    }
  }
  t.after(async () => {
    if (device !== undefined) {
      await device.message(HomeKitDevice.SHUTDOWN);
    }
  });
  const source = fs.readFileSync('dist/index.js', 'utf8');
  // Run the actual entrypoint startup block, isolating filesystem/config/UI boot.
  const startup = source.slice(source.indexOf('tempDevice = new IrrigationSystem'), source.indexOf('// Start HomeKit Web UI'));
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction(
    'IrrigationSystem',
    'HAP',
    'deviceData',
    'HomeKitDevice',
    'let tempDevice;\n' + startup + '\nreturn { device: tempDevice, accessory };',
  );
  const data = {
    serialNumber: failPublish === true ? 'startup-failure' : 'startup-success',
    softwareVersion: '0.0.8',
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
    eveHistory: true,
    programs: { enabled: false, schedules: [] },
  };
  return { run: () => run(StartupSystem, api, data, HomeKitDevice), publications };
}

test('startup publishes a configured accessory and passes its instance to the UI', async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(f.publications.length, 1);
  assert.equal(result.accessory, result.device.accessory);
  assert.ok(result.accessory instanceof HAP.Accessory);
  assert.ok(result.accessory.getService(HAP.Service.IrrigationSystem));
  assert.ok(result.accessory.getService(HAP.Service.Valve));
  assert.ok(result.device.historyService instanceof HomeKitHistory);
  assert.equal(f.publications[0].options.category, HAP.Categories.SPRINKLER);
  assert.equal(f.publications[0].options.username, 'AA:BB:CC:DD:EE:FF');
});

test('startup fails explicitly when accessory publication fails', async (t) => {
  const f = fixture(t, true);
  await assert.rejects(f.run(), /Unable to initialise and publish the HomeKit irrigation accessory/);
  assert.equal(f.publications.length, 1);
});
