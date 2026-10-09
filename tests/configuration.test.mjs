// Validate production configuration parsing without starting GPIO or HomeKit servers.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import HomeKitDevice from '../dist/HomeKitDevice.js';
import { crc32, validGPIOPin } from '../dist/utils.js';

function normalise(config) {
  const context = vm.createContext({
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify(config), writeFileSync: () => {} },
    crypto,
    crc32,
    validGPIOPin,
    HomeKitDevice,
    ACCESSORY_PINCODE: '031-45-154',
  });
  const source = fs.readFileSync('src/index.js', 'utf8');
  // Evaluate the actual loader; the entrypoint's startup has hardware side effects.
  vm.runInContext(
    source.slice(source.indexOf('function loadConfiguration'), source.indexOf('// Startup code')) +
      '\nglobalThis.config = loadConfiguration("fixture.json");',
    context,
  );
  return JSON.parse(JSON.stringify(context.config));
}

test('empty relay arrays stay empty; lists and scalar GPIO zero retain their shapes', () => {
  const config = normalise({
    zones: [
      { relayPin: [] },
      { relayPin: [20] },
      { relayPin: [20, 21] },
      { relayPin: 0 },
      { relayPin: [null, '', 20.5, 20] },
      { relayPin: null },
    ],
  });
  assert.deepEqual(
    config.zones.map((zone) => zone.relayPin),
    [[], [20], [20, 21], 0, [20], undefined],
  );
});

test('invalid tank and flow pins cannot be normalised to GPIO zero', () => {
  const config = normalise({ tanks: [{ sensorTrigPin: null, sensorEchoPin: [] }], options: { sensorFlowPin: null } });
  assert.equal(config.tanks[0].sensorTrigPin, undefined);
  assert.equal(config.tanks[0].sensorEchoPin, undefined);
  assert.equal(config.options.sensorFlowPin, undefined);
});
