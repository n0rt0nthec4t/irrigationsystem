// WaterTank
// Part of irrigationsystem
//
// Handles ultrasonic-based water level measurement.
// Uses an external binary for accurate sensor timing when available,
// with optional built-in Node.js GPIO fallback when no binary is configured.
//
// Responsibilities:
// - Read distance from ultrasonic sensor via external binary or GPIO fallback
// - Use a per-sample median to reduce one-off ultrasonic noise
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
// - Execute external binary (usonic_measure), or use GPIO fallback
// - Parse/normalise distance output
// - Use the current sample median as the measured distance
// - Convert to usable tank height
// - Emit updated level + percentage
//
// Lifecycle hooks used:
// - onShutdown() -> clears polling timer
//
// Requirements:
// - Valid trigger/echo GPIO pins
// - External ultrasonic binary, or assigned WaterTank.GPIO library fallback
//
// Code version 2026.10.09
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import process from 'node:process';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { validGPIOPin, LOG_LEVELS } from './utils.js';

// Define constants
const USONIC_READINGS = 5; // Number of readings per sensor sample
const USONIC_MIN_VALID_READINGS = Math.ceil(USONIC_READINGS / 2); // Require a valid majority
const USONIC_MIN_RANGE = 200; // mm
const USONIC_MAX_RANGE = 4500; // mm
const USONIC_TIMEOUT = 5000; // ms
const USONIC_SAMPLE_DELAY = 100; // ms; allow echoes to settle between triggers
const REFRESH_INTERVAL = 60 * 1000; // ms
export default class WaterTank {
  static GPIO = undefined; // GPIO library override
  static WATERLEVEL_EVENT = 'WATERLEVEL';

  uuid = undefined;
  log = undefined;
  waterlevel = undefined;
  percentage = undefined;

  // Internal data only for this class
  #HomeKitDeviceUUID = undefined;
  #readTimer = undefined;
  #reading = false;
  #stopped = false;
  #configurationVersion = 0;
  #cancelMeasurement = undefined;
  #sensorHeight = undefined;
  #minimumLevel = undefined;
  #triggerPin = undefined;
  #echoPin = undefined;
  #usonicBinary = undefined;

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

    this.#triggerPin = validGPIOPin(deviceData?.sensorTrigPin) === true ? Number(deviceData.sensorTrigPin) : undefined;
    this.#echoPin = validGPIOPin(deviceData?.sensorEchoPin) === true ? Number(deviceData.sensorEchoPin) : undefined;

    this.#usonicBinary = path.resolve(
      process.cwd(),
      typeof deviceData?.usonicBinary === 'string' && deviceData.usonicBinary.trim() !== ''
        ? deviceData.usonicBinary.trim().startsWith('~')
          ? path.join(os.homedir(), deviceData.usonicBinary.trim().slice(1))
          : deviceData.usonicBinary.trim()
        : './usonic_measure',
    );

    // Validate binary
    if (fs.existsSync(this.#usonicBinary) === false) {
      this?.log?.warn?.('Unable to find "%s" used to perform ultrasonic measurements for tank uuid "%s"', this.#usonicBinary, this.uuid);

      if (WaterTank.GPIO !== undefined && this.#triggerPin !== undefined && this.#echoPin !== undefined) {
        this?.log?.warn?.('Falling back to Node.js GPIO measurements (reduced accuracy) for tank uuid "%s"', this.uuid);

        this.#usonicBinary = undefined;
      } else {
        this?.log?.warn?.('No valid ultrasonic measurement method available for tank uuid "%s"', this.uuid);
        return;
      }
    }

    // Validate pins
    if (this.#echoPin === undefined || this.#triggerPin === undefined) {
      this?.log?.error?.('No GPIO pins are defined for ultrasonic readings for tank uuid "%s"', this.uuid);
      return;
    }

    // Validate tank dimensions
    if (this.#sensorHeight === undefined || this.#sensorHeight - this.#minimumLevel - USONIC_MIN_RANGE <= 0) {
      this?.log?.error?.('Invalid tank dimensions for tank uuid "%s"', this.uuid);
      return;
    }

    this?.log?.debug?.(
      'Using GPIO pins "%s" echo and "%s" trigger with "%s" for ultrasonic measurements on tank uuid "%s"',
      this.#echoPin,
      this.#triggerPin,
      this.#usonicBinary ?? 'Node.js GPIO fallback',
      this.uuid,
    );

    this.#startPolling();
  }

  onUpdate(deviceData = {}) {
    if (typeof deviceData !== 'object' || deviceData === null) {
      return;
    }
    let previous = [this.#sensorHeight, this.#minimumLevel, this.#triggerPin, this.#echoPin];

    if (Object.hasOwn(deviceData, 'sensorHeight') === true) {
      if (Number.isFinite(Number(deviceData.sensorHeight)) === true && Number(deviceData.sensorHeight) > 0) {
        this.#sensorHeight = Number(deviceData.sensorHeight);
      }
    }

    if (Object.hasOwn(deviceData, 'minimumLevel') === true) {
      if (Number.isFinite(Number(deviceData.minimumLevel)) === true && Number(deviceData.minimumLevel) >= 0) {
        this.#minimumLevel = Number(deviceData.minimumLevel);
      }
    }

    if (Object.hasOwn(deviceData, 'sensorTrigPin') === true) {
      this.#triggerPin = validGPIOPin(deviceData.sensorTrigPin) === true ? Number(deviceData.sensorTrigPin) : undefined;
    }

    if (Object.hasOwn(deviceData, 'sensorEchoPin') === true) {
      this.#echoPin = validGPIOPin(deviceData.sensorEchoPin) === true ? Number(deviceData.sensorEchoPin) : undefined;
    }

    let current = [this.#sensorHeight, this.#minimumLevel, this.#triggerPin, this.#echoPin];
    if (current.some((value, index) => value !== previous[index]) === true) {
      // Abort the old measurement and discard its sample. The reader restarts
      // after a recovery delay using only the new configuration.
      this.#configurationVersion++;
      this.#cancelMeasurement?.();
    }

    if (this.#echoPin === undefined || this.#triggerPin === undefined) {
      this?.log?.error?.('No GPIO pins are defined for ultrasonic readings for tank uuid "%s"', this.uuid);
      return;
    }

    if (this.#sensorHeight === undefined || this.#sensorHeight - this.#minimumLevel - USONIC_MIN_RANGE <= 0) {
      this?.log?.error?.('Invalid tank dimensions for tank uuid "%s"', this.uuid);
      return;
    }

    this.#startPolling();
  }

  // Configuration can become valid after construction. Start exactly one timer
  // and retry immediately whenever valid dimensions or pins are applied.
  #startPolling() {
    if (this.#stopped === true) {
      return;
    }
    if (this.#readTimer === undefined) {
      this.#readTimer = setInterval(() => {
        this.#readUsonicSensor();
      }, REFRESH_INTERVAL);
    }
    this.#readUsonicSensor();
  }

  async onShutdown() {
    this.#stopped = true;
    this.#cancelMeasurement?.();
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
    if (this.#reading === true || this.#stopped === true) {
      return;
    }

    if (
      this.#triggerPin === undefined ||
      this.#echoPin === undefined ||
      this.#sensorHeight === undefined ||
      this.#sensorHeight - this.#minimumLevel - USONIC_MIN_RANGE <= 0
    ) {
      return;
    }

    this.#reading = true;
    let configurationVersion = this.#configurationVersion;

    try {
      let median = (values = []) => {
        let sorted = [...values].sort((a, b) => a - b);
        let middle = Math.floor(sorted.length / 2);

        return sorted.length % 2 !== 0 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      };

      let readings = [];
      let attempts = [];

      for (let i = 0; i < USONIC_READINGS; i++) {
        // The JSN-SR04T needs at least 60 ms between triggers. Waiting after
        // each measurement also protects the binary path from residual echoes.
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, USONIC_SAMPLE_DELAY));
        }
        if (this.#stopped === true || configurationVersion !== this.#configurationVersion) {
          return;
        }
        let reading = await this.#readDistance();
        if (this.#stopped === true || configurationVersion !== this.#configurationVersion) {
          return;
        }
        attempts.push(Number.isFinite(reading) === true ? String(reading) + ' mm' : 'no reading');

        // Validate raw distances before clamping: invalid echoes must not become
        // full or empty readings at either limit of the sensor's operating range.
        if (
          Number.isFinite(reading) === true &&
          reading >= USONIC_MIN_RANGE &&
          reading <= USONIC_MAX_RANGE &&
          reading <= this.#sensorHeight
        ) {
          readings.push(reading);
        }
      }

      if (this.#stopped === true) {
        return;
      }
      // Keep the last valid level unless a majority of this sample succeeded.
      // This prevents one or two noisy echoes from replacing it with a false value.
      if (readings.length < USONIC_MIN_VALID_READINGS) {
        this?.log?.debug?.(
          'Ignoring ultrasonic sample for tank uuid "%s": received "%s" valid readings from "%s"; ' + 'distances: %s; sensor height: %s mm',
          this.uuid,
          readings.length,
          USONIC_READINGS,
          attempts.join(', '),
          this.#sensorHeight,
        );
        return;
      }

      // Median per-sample reading, robust against one-off ultrasonic spikes.
      let distance = median(readings);

      distance = Math.max(USONIC_MIN_RANGE, Math.min(USONIC_MAX_RANGE, distance));

      let usableHeight = this.#sensorHeight - this.#minimumLevel - USONIC_MIN_RANGE;

      if (usableHeight <= 0) {
        return;
      }

      // Distance is measured from the sensor down to the water surface.
      // Convert to usable water height, clamped between empty and full.
      // The bottom reserve and the sensor blind zone are different limits.
      // Empty usable volume starts at minimumLevel; full is 200 mm below the sensor.
      this.waterlevel = this.#sensorHeight - distance - this.#minimumLevel;
      this.waterlevel = Math.max(0, Math.min(usableHeight, this.waterlevel));

      this.percentage = (this.waterlevel / usableHeight) * 100;
      this.percentage = Math.max(0, Math.min(100, this.percentage));

      // Emit event via HomeKitDevice.
      if (this.#HomeKitDeviceUUID !== undefined) {
        HomeKitDevice.message(this.#HomeKitDeviceUUID, WaterTank.WATERLEVEL_EVENT, {
          uuid: this.uuid,
          waterlevel: this.waterlevel,
          percentage: this.percentage,
        });
      }
    } finally {
      if (this.#stopped === false && configurationVersion !== this.#configurationVersion) {
        await new Promise((resolve) => setTimeout(resolve, USONIC_SAMPLE_DELAY));
      }
      this.#reading = false;
      if (this.#stopped === false && configurationVersion !== this.#configurationVersion) {
        this.#readUsonicSensor();
      }
    }
  }

  async #readDistance() {
    // If no binary is available, use built-in GPIO fallback
    if (this.#usonicBinary === undefined) {
      let distance = await this.#measureDistanceGPIO();

      if (Number.isFinite(distance) === true) {
        return distance * 10;
      }

      return undefined;
    }

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
        this.#cancelMeasurement = undefined;

        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }

        resolve(value);
      };

      this.#cancelMeasurement = () => {
        // Complete before killing so late process events cannot affect a new read.
        finish(undefined);
        try {
          proc?.kill('SIGKILL');
        } catch (error) {
          this?.log?.debug?.('Unable to stop ultrasonic process for tank uuid "%s": %s', this.uuid, String(error));
        }
      };

      // Validate binary exists and is executable
      try {
        fs.accessSync(this.#usonicBinary, fs.constants.X_OK);
      } catch {
        this?.log?.debug?.('usonic binary "%s" not executable for tank uuid "%s"', this.#usonicBinary, this.uuid);

        this.#usonicBinary = undefined;
        finish(undefined);
        return;
      }

      // Spawn process
      try {
        proc = child_process.spawn(this.#usonicBinary, [this.#triggerPin, this.#echoPin]);
      } catch (error) {
        this?.log?.debug?.('Failed to start usonic measurement for tank uuid "%s": %s', this.uuid, String(error));

        this.#usonicBinary = undefined;
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

        if (line.includes('DISTANCE') === true) {
          let match = line.match(/^DISTANCE\s+([+-]?[0-9]+(?:\.[0-9]+)?)$/);

          if (match !== null) {
            let value = Number(match[1]) * 10;

            if (Number.isFinite(value) === true) {
              finish(value);
              return;
            }
          }
        }

        finish(undefined);
      });
    });
  }

  async #measureDistanceGPIO() {
    // If no GPIO library assigned, we cannot measure
    if (WaterTank.GPIO === undefined) {
      return undefined;
    }

    // Pins must be valid
    if (this.#triggerPin === undefined || this.#echoPin === undefined) {
      return undefined;
    }

    // Capture the pins and GPIO implementation for this measurement. Cleanup
    // must detach the original echo pin even when configuration changes mid-read.
    let gpio = WaterTank.GPIO;
    let triggerPin = this.#triggerPin;
    let echoPin = this.#echoPin;

    return new Promise((resolve) => {
      let riseTime = undefined;
      let timeoutTimer = undefined;
      let settleTimer = undefined;
      let completed = false;

      let finish = (distanceCm) => {
        if (completed === true) {
          return;
        }
        completed = true;
        clearTimeout(timeoutTimer);
        clearTimeout(settleTimer);
        this.#cancelMeasurement = undefined;
        try {
          gpio.poll(echoPin, null);
        } catch (error) {
          this?.log?.debug?.('Unable to stop ultrasonic GPIO polling for tank uuid "%s": %s', this.uuid, String(error));
        }
        resolve(distanceCm);
      };
      this.#cancelMeasurement = () => finish(undefined);

      try {
        gpio.open(triggerPin, gpio.OUTPUT, gpio.LOW);
        gpio.open(echoPin, gpio.INPUT);
        gpio.poll(
          echoPin,
          (pin) => {
            if (completed === true) {
              return;
            }
            if (gpio.read(pin) === gpio.HIGH) {
              riseTime = process.hrtime.bigint();
              return;
            }
            if (riseTime === undefined) {
              return;
            }
            let durationUs = Number((process.hrtime.bigint() - riseTime) / 1000n);
            finish(durationUs * 0.01715);
          },
          gpio.POLL_BOTH,
        );

        timeoutTimer = setTimeout(() => finish(undefined), 500);
        // A cancellable settling timer prevents a trigger after shutdown or an
        // update, rather than leaving a suspended async executor to resume later.
        settleTimer = setTimeout(() => {
          if (completed === true) {
            return;
          }
          try {
            gpio.write(triggerPin, gpio.HIGH);
            gpio.usleep(10);
            gpio.write(triggerPin, gpio.LOW);
          } catch (error) {
            this?.log?.debug?.('Ultrasonic GPIO trigger failed for tank uuid "%s": %s', this.uuid, String(error));
            finish(undefined);
          }
        }, 50);
      } catch (error) {
        this?.log?.debug?.('Ultrasonic GPIO setup failed for tank uuid "%s": %s', this.uuid, String(error));
        finish(undefined);
      }
    });
  }
}
