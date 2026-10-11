// Verify that pin lookups return the shared sensor owner during updates and removal.
import assert from 'node:assert/strict';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import FlowSensor from '../dist/flowsensor.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';

test('shared sensors retain pending volume and polling until their last target detaches', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100000 });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => Date.now());
  const messages = [];
  const polling = [];
  const previousGPIO = FlowSensor.GPIO;
  let pulse;
  FlowSensor.GPIO = {
    open() {},
    poll(pin, callback) {
      polling.push({ pin, callback });
      pulse = callback;
    },
  };
  t.mock.method(HomeKitDevice, 'message', (target, event, data) => {
    if (event === FlowSensor.FLOW_EVENT) {
      messages.push({ target, data });
    }
  });
  const owner = new FlowSensor(undefined, 'first', { sensorPin: 18, flowRate: 1 });
  const shared = new FlowSensor(undefined, 'second', { sensorPin: 18, flowRate: 1 });
  t.after(() => {
    shared.onShutdown();
    owner.onShutdown();
    FlowSensor.GPIO = previousGPIO;
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });

  assert.equal(polling.length, 1);
  pulse();
  shared.onUpdate({ flowRate: 2 });
  assert.deepEqual(
    messages.map((message) => message.target),
    ['first', 'second'],
  );
  assert.equal(messages[0].data.volume, 1 / 60);
  assert.equal(messages[1].data.volume, 1 / 60);

  t.mock.timers.tick(25);
  pulse();
  shared.onShutdown();
  assert.equal(messages.length, 4);
  assert.equal(messages[2].data.volume, 2 / 60);
  assert.equal(polling.length, 1);

  t.mock.timers.tick(25);
  pulse();
  owner.onShutdown();
  assert.equal(messages.length, 5);
  assert.equal(messages[4].target, 'first');
  assert.equal(messages[4].data.volume, 2 / 60);
  assert.deepEqual(polling[1], { pin: 18, callback: null });
  owner.onShutdown();
  shared.onShutdown();
  assert.equal(polling.length, 2);
  // Detached instances cannot update leak state through a fallback owner.
  owner.setLeakDetectionEnabled(true);
  shared.markExpectedFlow(true);
  assert.equal(owner.isLeaking(), false);
  assert.equal(shared.isLeaking(), false);
});
