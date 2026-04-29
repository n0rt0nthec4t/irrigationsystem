// WaterTank
// Part of irrigationsystem
//
// Handles ultrasonic-based water level measurement using an external binary.
// Designed as a self-contained device that reports readings via the
// HomeKitDevice messaging system.
//
// Responsibilities:
// - Read distance from ultrasonic sensor via external binary
// - Smooth readings using rolling average buffer
// - Reject obvious noisy/spike readings
// - Convert distance to water level and percentage
// - Emit WATERLEVEL events via HomeKitDevice message bus
// - Handle lifecycle cleanup (shutdown)
//
// Architecture:
// - No direct references to parent system
// - Emits events via HomeKitDevice.message(...)
// - Polled at fixed interval
//
// Flow:
// - Execute external binary (usonic_measure)
// - Parse distance output
// - Apply smoothing buffer
// - Convert to usable tank height
// - Emit updated level + percentage
//
// Lifecycle hooks used:
// - onShutdown() -> clears polling timer
//
// Requirements:
// - Valid trigger/echo GPIO pins
// - External ultrasonic binary must exist and be executable
//
// Code version 2026.04.29
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import process from 'node:process';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define constants
const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

const USONIC_READINGS = 1; // Number of readings per sensor sample
const USONIC_MIN_RANGE = 200; // mm
const USONIC_MAX_RANGE = 4500; // mm
const USONIC_TIMEOUT = 5000; // ms
const REFRESH_INTERVAL = 60 * 1000; // ms
const SMOOTHING_BUFFER = 5; // Number of recent readings to average
const SPIKE_THRESHOLD = 300; // mm

export default class WaterTank {
  static WATERLEVEL_EVENT = 'WATERLEVEL';

  uuid = undefined;
  log = undefined;
  waterlevel = undefined;
  percentage = undefined;

  // Internal data only for this class
  #HomeKitDeviceUUID = undefined;
  #readTimer = undefined;
  #reading = false;
  #sensorHeight = undefined;
  #minimumLevel = undefined;
  #triggerPin = undefined;
  #echoPin = undefined;
  #usonicBinary = undefined;
  #distanceBuffer = [];

  constructor(log = undefined, uuid = undefined, deviceData = {}) {
    // Validate the passed in logging object. We are expecting certain functions to be present
    if (Object.values(LOG_LEVELS).every((fn) => typeof log?.[fn] === 'function')) {
      this.log = log;
    }

    // Store HomeKitDevice UUID for message routing
    this.#HomeKitDeviceUUID = typeof uuid === 'string' && uuid !== '' ? uuid : undefined;

    if (this.#HomeKitDeviceUUID !== undefined) {
      HomeKitDevice.message(this.#HomeKitDeviceUUID, HomeKitDevice.SHUTDOWN, this);
    }

    this.uuid = typeof deviceData?.uuid === 'string' && deviceData.uuid !== '' ? deviceData.uuid : crypto.randomUUID();

    this.#sensorHeight =
      Number.isFinite(Number(deviceData?.sensorHeight)) === true && Number(deviceData.sensorHeight) > 0
        ? Number(deviceData.sensorHeight)
        : undefined;

    this.#minimumLevel =
      Number.isFinite(Number(deviceData?.minimumLevel)) === true && Number(deviceData.minimumLevel) >= 0
        ? Number(deviceData.minimumLevel)
        : 0;

    this.#triggerPin =
      Number.isFinite(Number(deviceData?.sensorTrigPin)) === true &&
      Number(deviceData.sensorTrigPin) >= 0 &&
      Number(deviceData.sensorTrigPin) <= 26
        ? Number(deviceData.sensorTrigPin)
        : undefined;

    this.#echoPin =
      Number.isFinite(Number(deviceData?.sensorEchoPin)) === true &&
      Number(deviceData.sensorEchoPin) >= 0 &&
      Number(deviceData.sensorEchoPin) <= 26
        ? Number(deviceData.sensorEchoPin)
        : undefined;

    this.#usonicBinary = path.resolve(
      process.cwd(),
      typeof deviceData?.usonicBinary === 'string' && deviceData.usonicBinary !== '' ? deviceData.usonicBinary : './usonic_measure',
    );

    // Validate binary
    if (fs.existsSync(this.#usonicBinary) === false) {
      this?.log?.warn?.('Unable to find "%s" used to perform ultrasonic waterlevel measurements', this.#usonicBinary);
      this?.log?.warn?.('Waterlevel measurements for tank uuid "%s" will be disabled', this.uuid);
      return;
    }

    // Validate pins
    if (this.#echoPin === undefined || this.#triggerPin === undefined) {
      this?.log?.error?.('No GPIO pins are defined for ultrasonic readings for tank uuid "%s"', this.uuid);
      return;
    }

    // Validate tank dimensions
    if (this.#sensorHeight === undefined || this.#sensorHeight - this.#minimumLevel <= 0) {
      this?.log?.error?.('Invalid tank dimensions for tank uuid "%s"', this.uuid);
      return;
    }

    this?.log?.debug?.(
      'Using GPIO pins "%s" echo and "%s" trigger with "%s" for ultrasonic measurements on tank uuid "%s"',
      this.#echoPin,
      this.#triggerPin,
      this.#usonicBinary,
      this.uuid,
    );

    // Initial read
    this.#readUsonicSensor();

    // Start polling loop
    this.#readTimer = setInterval(() => {
      this.#readUsonicSensor();
    }, REFRESH_INTERVAL);
  }

  async onShutdown() {
    if (this.#readTimer !== undefined) {
      clearInterval(this.#readTimer);
      this.#readTimer = undefined;
    }
  }

  getLevel() {
    return {
      uuid: this.uuid,
      waterlevel: this.waterlevel,
      percentage: this.percentage,
    };
  }

  async #readUsonicSensor() {
    if (this.#reading === true) {
      return;
    }

    if (this.#triggerPin === undefined || this.#echoPin === undefined || this.#sensorHeight === undefined) {
      return;
    }

    this.#reading = true;

    try {
      let distance = 0;
      let readings = [];

      for (let i = 0; i < USONIC_READINGS; i++) {
        let reading = await this.#readDistance();

        if (Number.isFinite(Number(reading)) === true && Number(reading) > 0) {
          readings.push(Number(reading));
        }
      }

      if (readings.length === 0) {
        return;
      }

      distance = readings.reduce((a, b) => a + b, 0) / readings.length;
      distance = Math.max(USONIC_MIN_RANGE, Math.min(USONIC_MAX_RANGE, distance));

      if (distance > this.#sensorHeight) {
        distance = this.#sensorHeight;
      }

      // Reject obvious ultrasonic spikes before adding to smoothing buffer
      if (this.#distanceBuffer.length !== 0) {
        let lastDistance = this.#distanceBuffer[this.#distanceBuffer.length - 1];

        if (Math.abs(distance - lastDistance) > SPIKE_THRESHOLD) {
          this?.log?.debug?.('Ignoring noisy usonic spike for tank uuid "%s": %s -> %s', this.uuid, lastDistance, distance);
          return;
        }
      }

      // Smoothing buffer
      this.#distanceBuffer.push(distance);
      if (this.#distanceBuffer.length > SMOOTHING_BUFFER) {
        this.#distanceBuffer.shift();
      }

      let avgDistance = this.#distanceBuffer.reduce((a, b) => a + b, 0) / this.#distanceBuffer.length;
      let usableHeight = this.#sensorHeight - this.#minimumLevel;

      if (usableHeight <= 0) {
        return;
      }

      // Distance is measured from the sensor down to the water surface.
      // Convert to usable water height, clamped between empty and full.
      this.waterlevel = usableHeight - Math.max(0, avgDistance - USONIC_MIN_RANGE);
      this.waterlevel = Math.max(0, Math.min(usableHeight, this.waterlevel));

      this.percentage = (this.waterlevel / usableHeight) * 100;
      this.percentage = Math.max(0, Math.min(100, this.percentage));

      // Emit event via HomeKitDevice
      if (this.#HomeKitDeviceUUID !== undefined) {
        HomeKitDevice.message(this.#HomeKitDeviceUUID, WaterTank.WATERLEVEL_EVENT, {
          uuid: this.uuid,
          waterlevel: this.waterlevel,
          percentage: this.percentage,
        });
      }
    } finally {
      this.#reading = false;
    }
  }

  async #readDistance() {
    return await new Promise((resolve) => {
      let output = '';
      let timeout = undefined;
      let proc = undefined;
      let resolved = false;

      let finish = (value) => {
        if (resolved === true) {
          return;
        }

        resolved = true;
        clearTimeout(timeout);
        resolve(value);
      };

      try {
        proc = child_process.spawn(this.#usonicBinary, [this.#triggerPin, this.#echoPin]);
      } catch (error) {
        this?.log?.debug?.('Failed to start usonic measurement for tank uuid "%s": %s', this.uuid, String(error));
        finish(undefined);
        return;
      }

      timeout = setTimeout(() => {
        this?.log?.debug?.('usonic measurement timeout for tank uuid "%s"', this.uuid);

        try {
          proc.kill('SIGKILL');
        } catch {
          // Empty
        }

        finish(undefined);
      }, USONIC_TIMEOUT);

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        this?.log?.debug?.('usonic measurement stderr for tank uuid "%s": %s', this.uuid, data.toString().trim());
      });

      proc.on('error', (error) => {
        this?.log?.debug?.('usonic measurement error for tank uuid "%s": %s', this.uuid, String(error));
        finish(undefined);
      });

      proc.on('close', () => {
        let line = output.trim().toUpperCase();

        if (line === '') {
          finish(undefined);
          return;
        }

        if (line === 'OUT OF RANGE') {
          this?.log?.debug?.('usonic measurement returned "out of range" for tank uuid "%s"', this.uuid);
          finish(undefined);
          return;
        }

        if (line.startsWith('DISTANCE') === true) {
          let value = Number(line.split(' ')[1]) * 10;

          if (Number.isFinite(Number(value)) === true) {
            finish(Math.max(USONIC_MIN_RANGE, Math.min(USONIC_MAX_RANGE, Number(value))));
            return;
          }
        }

        finish(undefined);
      });
    });
  }
}
