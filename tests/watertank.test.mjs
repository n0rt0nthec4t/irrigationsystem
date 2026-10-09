// Exercise the built ultrasonic reader with a fake measurement process and clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import WaterTank from '../dist/watertank.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';

function fixture(t, sensorHeight = 1970) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  syncBuiltinESMExports();
  let distance = 1770;
  let samples = 0;
  const events = [];
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'accessSync', () => {});
  t.mock.method(childProcess, 'spawn', () => {
    samples++;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    Promise.resolve().then(() => {
      proc.stdout.emit('data', 'DISTANCE ' + distance / 10);
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
    setDistance: (value) => {
      distance = value;
    },
    sampleCount: () => samples,
  };
}

async function settle() {
  for (let index = 0; index < 50; index++) {
    await Promise.resolve();
  }
}

test('minimum usable level is empty; blind-zone full and halfway readings have correct percentages', async (t) => {
  const f = fixture(t);
  await settle();
  assert.equal(f.tank.getLevel().percentage, 0);
  assert.equal(f.tank.getLevel().waterlevel, 0);
  f.setDistance(200);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(f.tank.getLevel().percentage, 100);
  assert.equal(f.tank.getLevel().waterlevel, 1570);
  f.setDistance(985);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(f.tank.getLevel().percentage, 50);
  assert.equal(f.tank.getLevel().waterlevel, 785);
});

test('correcting invalid initial dimensions starts and maintains exactly one polling timer', async (t) => {
  const f = fixture(t, 0);
  assert.equal(f.sampleCount(), 0);
  f.tank.onUpdate({ sensorHeight: 1970 });
  await settle();
  assert.equal(f.sampleCount(), 5);
  f.setDistance(985);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(f.sampleCount(), 10);
  assert.equal(f.tank.getLevel().percentage, 50);
  f.tank.onUpdate({ sensorHeight: 1970 });
  await settle();
  assert.equal(f.sampleCount(), 15);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(f.sampleCount(), 20);
  await f.tank.onShutdown();
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(f.sampleCount(), 20);
});

test('dimensions with no space between the reserve and blind zone are rejected', async (t) => {
  const f = fixture(t, 400);
  await settle();
  assert.equal(f.sampleCount(), 0);
  assert.equal(f.events.length, 0);
});
