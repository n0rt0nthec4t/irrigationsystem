// Code version 10/10/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import process from 'node:process';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setInterval } from 'node:timers';

const USONICREADINGS = 1; // Number of usonic readings made to get a measurement
const USONICMINRANGE = 200; // Minimum range for ultrasonic sensor in mm
const USONICMAXRANGE = 4500; // maximum range for ultrasonic sensor in mm
const REFRESHINTERVAL = 60 * 1000; // Refresh water tank level every 60 seconds

export default class WaterTank {
  static WATERLEVEL = 'WATERLEVEL'; // Water tank level event tag

  uuid = undefined;
  log = undefined; // Logging function object
  waterlevel = undefined;
  percentage = undefined;

  // Internal data only for this class
  #eventEmitter = undefined;
  #readTimer = undefined;
  #sensorHeight = undefined;
  #minimumLevel = undefined;
  #GPIO_trigPin = undefined;
  #GPIO_echoPin = undefined;

  constructor(log, uuid, sensorHeight, minimumLevel, sensorTrigPin, sensorEchoPin, eventEmitter) {
    // Validate the passed in logging object. We are expecting certain functions to be present
    if (
      typeof log?.info === 'function' &&
      typeof log?.success === 'function' &&
      typeof log?.warn === 'function' &&
      typeof log?.error === 'function' &&
      typeof log?.debug === 'function'
    ) {
      this.log = log;
    }

    // Validate if eventEmitter object passed to us is an instance of EventEmitter
    if (eventEmitter instanceof EventEmitter === true) {
      this.#eventEmitter = eventEmitter;
    }

    this.uuid = uuid !== undefined ? uuid : crypto.randomUUID();
    this.#sensorHeight = isNaN(sensorHeight) === false ? Number(sensorHeight) : undefined; // sensorHeight of watertank in millimeters
    this.#minimumLevel = isNaN(minimumLevel) === false ? Number(minimumLevel) : undefined; // Minimum usable waterlevel in millimeters
    this.#GPIO_trigPin =
      isNaN(sensorTrigPin) === false && Number(sensorTrigPin) >= 0 && Number(sensorTrigPin) <= 26 ? Number(sensorTrigPin) : undefined;
    this.#GPIO_echoPin =
      isNaN(sensorEchoPin) === false && Number(sensorEchoPin) >= 0 && Number(sensorEchoPin) <= 26 ? Number(sensorEchoPin) : undefined;

    if (fs.existsSync(path.resolve(process.cwd() + '/usonic_measure')) === false) {
      this?.log?.warn &&
        this.log.warn(
          'unabled to find "%s" which is used to perform ultrasonic waterlevel measurements',
          path.resolve(process.cwd() + '/usonic_measure'),
        );
      this?.log?.warn && this.log.warn('waterlevel measurements for tank uuid "%s" will be disabled', this.uuid);
    }

    if (
      fs.existsSync(path.resolve(process.cwd() + '/usonic_measure')) === true &&
      this.#GPIO_echoPin === undefined &&
      this.#GPIO_trigPin === undefined
    ) {
      this?.log?.error &&
        this.log.error('No GPIO pins are defined for the ultrasonic echo and trigger readings for tank uuid "%s"', this.uuid);
    }

    if (
      fs.existsSync(path.resolve(process.cwd() + '/usonic_measure')) === true &&
      this.#GPIO_echoPin !== undefined &&
      this.#GPIO_trigPin !== undefined
    ) {
      this?.log?.debug &&
        this.log.debug(
          'Using GPIO pins "%s, %s" ultrasonic water level measurements for tank uuid "%s"',
          this.#GPIO_echoPin,
          this.#GPIO_trigPin,
          this.uuid,
        );
      // Perform an inital read of the watertank level
      this.#readUsonicSensor();

      // Setup interval to refresh watertank level
      this.#readTimer = setInterval(this.#readUsonicSensor.bind(this), REFRESHINTERVAL);
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
    if (
      fs.existsSync(path.resolve(process.cwd() + '/usonic_measure')) === false ||
      this.#GPIO_trigPin === undefined ||
      this.#GPIO_echoPin === undefined
    ) {
      return;
    }

    // Gets the level of the water tank, averages and calculates percentage full
    let actualDistance = 0;
    let averageDistance = 0;

    for (let index = 0; index < USONICREADINGS; index++) {
      let usonicProcess = child_process.spawn(path.resolve(process.cwd() + '/usonic_measure'), [this.#GPIO_trigPin, this.#GPIO_echoPin]);

      usonicProcess.stdout.on('data', (data) => {
        if (data.toString().toUpperCase() === 'OUT OF RANGE') {
          // lets assume if we get an out of range measurement, we're below the minimin workable distance
          this?.log?.debug && this.log.debug('usonic measurement returned an "out of range" reading');
          actualDistance = USONICMINRANGE;
        }
        if (data.toString().split(':')[0].toUpperCase() === 'DISTANCE') {
          // we have a distance measurement. formatted as "Distance: xxxx cm"
          actualDistance = data.toString().split(' ')[1] * 10; // Convert CM to MM

          // Baseline measurement
          if (actualDistance < USONICMINRANGE) {
            actualDistance = USONICMINRANGE;
          }
          if (actualDistance > USONICMAXRANGE) {
            actualDistance = USONICMAXRANGE;
          }
          if (actualDistance > this.#sensorHeight) {
            actualDistance = this.#sensorHeight;
          }
        }

        // Average readings
        averageDistance = averageDistance + actualDistance;
      });

      await EventEmitter.once(usonicProcess, 'exit'); // Wait until childprocess (usonic_measure) has issued exit event
    }

    if (averageDistance !== 0 && actualDistance !== 0) {
      averageDistance = averageDistance / USONICREADINGS;

      // Adjust the measured sensor height if we have a minimum usable water level in tank, then scale
      // Since the minimum workable range might not be zero, scale the min usonic <> tank sensor height into 0 <> tank sensor eight
      this.waterlevel =
        this.#sensorHeight -
        this.#minimumLevel -
        scaleValue(averageDistance, USONICMINRANGE, this.#sensorHeight - this.#minimumLevel, 0, this.#sensorHeight - this.#minimumLevel);
      this.percentage = (this.waterlevel / (this.#sensorHeight - this.#minimumLevel)) * 100;
      if (this.percentage < 0) {
        this.percentage = 0;
      }
      if (this.percentage > 100) {
        this.percentage = 100;
      }

      // Send out an event with the updated watertank level. This will only be sent if the usonic readings were successful
      if (this.#eventEmitter !== undefined) {
        this.#eventEmitter.emit(WaterTank.WATERLEVEL, {
          uuid: this.uuid,
          waterlevel: this.waterlevel,
          percentage: this.percentage,
        });
      }
    }
  }
}

// General helper functions which don't need to be part of an object class
function scaleValue(value, sourceRangeMin, sourceRangeMax, targetRangeMin, targetRangeMax) {
  if (value < sourceRangeMin) {
    value = sourceRangeMin;
  }
  if (value > sourceRangeMax) {
    value = sourceRangeMax;
  }
  return ((value - sourceRangeMin) * (targetRangeMax - targetRangeMin)) / (sourceRangeMax - sourceRangeMin) + targetRangeMin;
}
