// Exercise the built ultrasonic reader with a fake measurement process and clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import WaterTank from '../dist/watertank.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';

function fixture(t, sensorHeight = 1970, minimumInterval = 0) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  syncBuiltinESMExports();
  let distance = 1770;
  let samples = 0;
  let cancellations = 0;
  let previousTrigger = -Infinity;
  const triggerTimes = [];
  const triggerPins = [];
  const events = [];
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'accessSync', () => {});
  t.mock.method(childProcess, 'spawn', (_binary, pins) => {
    samples++;
    triggerPins.push([...pins]);
    const triggerTime = Date.now();
    const measuredDistance = triggerTime - previousTrigger >= minimumInterval ? distance : undefined;
    previousTrigger = triggerTime;
    triggerTimes.push(triggerTime);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {
      cancellations++;
    };
    Promise.resolve().then(() => {
      proc.stdout.emit('data', measuredDistance === undefined ? 'OUT OF RANGE' : 'DISTANCE ' + measuredDistance / 10);
      proc.emit('close', 0);
    });
    return proc;
  });
  t.mock.method(HomeKitDevice, 'message', async (_uuid, type, value) => {
    if (type === WaterTank.WATERLEVEL_EVENT) {
      events.push(value);
    }
  });
  const tank = new WaterTank(undefined, 'system', {
    uuid: 'tank',
    sensorHeight,
    minimumLevel: 200,
    sensorTrigPin: 20,
    sensorEchoPin: 21,
    usonicBinary: '/fake/usonic_measure',
  });
  t.after(async () => {
    await tank.onShutdown();
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return {
    tank,
    events,
    triggerTimes,
    triggerPins,
    setDistance: (value) => {
      distance = value;
    },
    sampleCount: () => samples,
    cancellationCount: () => cancellations,
  };
}

async function settle(t) {
  // Drain process callbacks before advancing each inter-measurement delay.
  for (let step = 0; step < 5; step++) {
    for (let index = 0; index < 50; index++) {
      await Promise.resolve();
    }
    t.mock.timers.tick(100);
  }
}

test('minimum usable level is empty; blind-zone full and halfway readings have correct percentages', async (t) => {
  const f = fixture(t);
  await settle(t);
  assert.equal(f.tank.getLevel().percentage, 0);
  assert.equal(f.tank.getLevel().waterlevel, 0);
  f.setDistance(200);
  t.mock.timers.tick(60000);
  await settle(t);
  assert.equal(f.tank.getLevel().percentage, 100);
  assert.equal(f.tank.getLevel().waterlevel, 1570);
  f.setDistance(985);
  t.mock.timers.tick(60000);
  await settle(t);
  assert.equal(f.tank.getLevel().percentage, 50);
  assert.equal(f.tank.getLevel().waterlevel, 785);
});

test('correcting invalid initial dimensions starts and maintains exactly one polling timer', async (t) => {
  const f = fixture(t, 0);
  assert.equal(f.sampleCount(), 0);
  f.tank.onUpdate({ sensorHeight: 1970 });
  await settle(t);
  assert.equal(f.sampleCount(), 5);
  f.setDistance(985);
  t.mock.timers.tick(60000);
  await settle(t);
  assert.equal(f.sampleCount(), 10);
  assert.equal(f.tank.getLevel().percentage, 50);
  f.tank.onUpdate({ sensorHeight: 1970 });
  await settle(t);
  assert.equal(f.sampleCount(), 15);
  t.mock.timers.tick(60000);
  await settle(t);
  assert.equal(f.sampleCount(), 20);
  await f.tank.onShutdown();
  t.mock.timers.tick(60000);
  await settle(t);
  assert.equal(f.sampleCount(), 20);
});

test('dimensions with no space between the reserve and blind zone are rejected', async (t) => {
  const f = fixture(t, 400);
  await settle(t);
  assert.equal(f.sampleCount(), 0);
  assert.equal(f.events.length, 0);
});

test('five measurements allow sensor recovery instead of accepting only the first echo', async (t) => {
  const f = fixture(t, 1970, 60);
  f.setDistance(985);
  await settle(t);
  assert.equal(f.sampleCount(), 5);
  assert.equal(f.events.length, 1);
  for (let index = 1; index < f.triggerTimes.length; index++) {
    assert.ok(f.triggerTimes[index] - f.triggerTimes[index - 1] >= 100);
  }
  // The first measurement used the original distance; the median uses the four
  // subsequent recovered echoes, yielding the updated level.
  assert.equal(f.tank.getLevel().percentage, 50);
});

test('out-of-range raw echoes retain the last valid level instead of becoming full or empty', async (t) => {
  const f = fixture(t);
  f.setDistance(985);
  await settle(t);
  assert.equal(f.tank.getLevel().percentage, 50);
  for (const distance of [-100, 0, 100, 2000, 5000]) {
    f.setDistance(distance);
    t.mock.timers.tick(60000);
    await settle(t);
    assert.equal(f.tank.getLevel().percentage, 50);
    assert.equal(f.events.length, 1);
  }
});

test('shutdown during a sample prevents subsequent triggers and water-level events', async (t) => {
  const f = fixture(t);
  await f.tank.onShutdown();
  assert.equal(f.cancellationCount(), 1);
  await settle(t);
  assert.equal(f.sampleCount(), 1);
  assert.equal(f.events.length, 0);
  f.tank.onUpdate({ sensorHeight: 1970 });
  t.mock.timers.tick(60000);
  await settle(t);
  assert.equal(f.sampleCount(), 1);
});

test('a tank pin change discards the old sample and restarts with five new readings', async (t) => {
  const f = fixture(t);
  f.setDistance(985);
  f.tank.onUpdate({ sensorTrigPin: 22, sensorEchoPin: 23 });
  assert.equal(f.cancellationCount(), 1);
  assert.equal(f.events.length, 0);
  await settle(t);
  await settle(t);
  assert.deepEqual(f.triggerPins, [[20, 21], ...Array.from({ length: 5 }, () => [22, 23])]);
  assert.equal(f.events.length, 1);
  assert.equal(f.tank.getLevel().percentage, 50);
});

// Exercise fallback cancellation without generating real GPIO edges.
function gpioFixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  syncBuiltinESMExports();
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(HomeKitDevice, 'message', async () => {});
  const writes = [];
  const polls = new Map();
  const originalGPIO = WaterTank.GPIO;
  WaterTank.GPIO = {
    OUTPUT: 1,
    INPUT: 0,
    HIGH: 1,
    LOW: 0,
    POLL_BOTH: 3,
    open() {},
    poll(pin, callback) {
      polls.set(pin, callback);
    },
    write(pin, value) {
      writes.push({ pin, value });
    },
    usleep() {},
    read() {
      return 0;
    },
  };
  const tank = new WaterTank(undefined, 'system', {
    sensorHeight: 1970,
    minimumLevel: 200,
    sensorTrigPin: 20,
    sensorEchoPin: 21,
  });
  t.after(async () => {
    await tank.onShutdown();
    WaterTank.GPIO = originalGPIO;
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return { tank, writes, polls };
}

test('GPIO shutdown cancels settling and detaches polling immediately', async (t) => {
  const f = gpioFixture(t);
  await f.tank.onShutdown();
  assert.equal(f.polls.get(21), null);
  await settle(t);
  assert.deepEqual(f.writes, []);
});

test('GPIO pin changes cancel the old trigger and clean up the original echo pin', async (t) => {
  const f = gpioFixture(t);
  f.tank.onUpdate({ sensorTrigPin: 22, sensorEchoPin: 23 });
  assert.equal(f.polls.get(21), null);
  await settle(t);
  assert.ok(f.writes.some((write) => write.pin === 22 && write.value === 1));
  assert.equal(
    f.writes.some((write) => write.pin === 20),
    false,
  );
  assert.equal(typeof f.polls.get(23), 'function');
});
