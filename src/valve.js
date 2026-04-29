// Valve
// Part of irrigationsystem
//
// Handles control of a single irrigation valve using a GPIO relay and optional
// shared flow sensor input. Designed to operate as a self-contained device
// within the HomeKitDevice messaging architecture.
//
// Responsibilities:
// - Control relay GPIO to open/close irrigation valves
// - Track valve runtime and accumulated water usage
// - Integrate with shared flow sensors (per GPIO pin) with smoothing
// - Emit valve state changes and flow events via HomeKitDevice message bus
// - Respond to lifecycle events (TIMER, SHUTDOWN)
//
// Architecture:
// - Each Valve instance is a lightweight, autonomous component
// - Communication is handled via HomeKitDevice.message(...)
// - No direct references to parent system or other valves
// - Multiple valves may share a single flow sensor pin
//
// Flow Sensor Model:
// - One polling loop per sensor pin (shared across all valves)
// - Pulse counting via GPIO interrupt/poll
// - Smoothed volume calculation using a rolling average buffer
// - Water usage attributed only to currently open valves
//
// Events emitted:
// - Valve.VALVE_EVENT -> open/close state changes with usage stats
// - Valve.FLOW_EVENT  -> periodic flow rate/volume updates (shared)
//
// Lifecycle hooks used:
// - onShutdown() -> ensures valve is closed safely
// - onTimer()    -> (optional) runtime enforcement / future scheduling
//
// Requirements:
// - GPIO library must be assigned to Valve.GPIO before use
// - Relay pins must be valid GPIO numbers within defined range
// - Flow sensor pins must be valid GPIO numbers and configured with flow rate
//
// Code version 2026.04.29
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';

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

export default class Valve {
  static GPIO = undefined; // GPIO library override
  static FLOW_EVENT = 'FLOWEVENT'; // Water flow event tag
  static VALVE_EVENT = 'VALVEEVENT'; // Valve event tag

  // GPIO pin min/max
  static MIN_GPIO_PIN = 0;
  static MAX_GPIO_PIN = 26;

  // Valve status types
  static OPENED = 'opened';
  static CLOSED = 'closed';

  // Static map to track flow pins across all instances
  static #flowPins = {};

  valveOpenedTime = undefined; // Time valve was opened
  waterAmount = 0; // Water usage during valve open period

  // Internal data only for this class
  #HomeKitDeviceUUID = undefined;
  #valvePin = undefined; // GPIO pin on which valve can be operated on
  #sensorFlowPin = undefined; // GPIO pin used for shared water flow tracking

  constructor(log = undefined, uuid = undefined, deviceData = {}) {
    // Validate the passed in logging object. We are expecting certain functions to be present
    if (Object.values(LOG_LEVELS).every((fn) => typeof log?.[fn] === 'function')) {
      this.log = log;
    }

    this.#HomeKitDeviceUUID = typeof uuid === 'string' && uuid !== '' ? uuid : undefined;

    if (this.#HomeKitDeviceUUID !== undefined) {
      HomeKitDevice.message(this.#HomeKitDeviceUUID, HomeKitDevice.TIMER, this);
      HomeKitDevice.message(this.#HomeKitDeviceUUID, HomeKitDevice.SHUTDOWN, this);
    }

    this.uuid = typeof deviceData?.uuid === 'string' && deviceData.uuid !== '' ? deviceData.uuid : crypto.randomUUID();
    this.#valvePin = this.#validGPIOPin(deviceData?.relayPin) === true ? Number(deviceData.relayPin) : undefined;
    this.#sensorFlowPin = this.#validGPIOPin(deviceData?.sensorFlowPin) === true ? Number(deviceData.sensorFlowPin) : undefined;

    if (this.#valvePin === undefined) {
      this?.log?.warn?.('No relay pin specified for irrigation zone valve "%s"', deviceData?.name ?? 'Unknown');
    }

    if (Valve.GPIO === undefined) {
      this?.log?.error?.('No GPIO library has been specifed for this class. Valves cannot be operated via hardware');
    }

    if (this.#valvePin !== undefined && Valve.GPIO !== undefined) {
      this?.log?.debug?.('Setting up irrigation zone valve "%s" using relay pin "%s"', deviceData?.name, this.#valvePin);

      // Initialise the GPIO output PINs for this valve, closed for default
      Valve.GPIO.open(this.#valvePin, Valve.GPIO.OUTPUT, Valve.GPIO.LOW);
    }

    // Setup shared flow tracking for this flow pin if not already registered
    if (this.#sensorFlowPin !== undefined && Valve.GPIO !== undefined) {
      this.#setupFlowSensor(deviceData);
    }
  }

  async onShutdown() {
    // Close the valve if it is still open to ensure safe shutdown state
    this.close();

    // Clean up flow pin registration for this valve
    if (this.#sensorFlowPin === undefined || Valve.#flowPins[this.#sensorFlowPin] === undefined) {
      return;
    }

    let flowPin = Valve.#flowPins[this.#sensorFlowPin];

    flowPin.valves.delete(this);
    flowPin.targets.delete(this.#HomeKitDeviceUUID);

    if (flowPin.valves.size !== 0) {
      return;
    }

    clearInterval(flowPin.timer);

    try {
      Valve.GPIO?.poll?.(this.#sensorFlowPin, null);
    } catch {
      // Empty
    }

    delete Valve.#flowPins[this.#sensorFlowPin];
    this.#sensorFlowPin = undefined;
  }

  open() {
    if (this.#valvePin === undefined || Valve.GPIO === undefined) {
      return;
    }

    if (this.valveOpenedTime !== undefined) {
      return;
    }

    // Output a high signal on the GPIO, this will trigger the connected relay to open
    this?.log?.debug?.('Received request to open irrigation valve on relay pin "%s"', this.#valvePin);
    Valve.GPIO.write(this.#valvePin, Valve.GPIO.HIGH);

    this.valveOpenedTime = Math.floor(Date.now() / 1000);
    this.waterAmount = 0;

    // Send out an event with the updated valve status
    // Emit event via HomeKitDevice
    if (this.#HomeKitDeviceUUID !== undefined) {
      HomeKitDevice.message(this.#HomeKitDeviceUUID, Valve.VALVE_EVENT, {
        uuid: this.uuid,
        pin: this.#valvePin,
        status: Valve.OPENED,
        time: this.valveOpenedTime,
        water: 0,
        duration: 0,
      });
    }
  }

  close() {
    if (this.#valvePin === undefined || Valve.GPIO === undefined) {
      return;
    }

    // Output a low signal on the GPIO, this will trigger the connected relay to close
    this?.log?.debug?.('Received request to close irrigation valve on relay pin "%s"', this.#valvePin);
    Valve.GPIO.write(this.#valvePin, Valve.GPIO.LOW);

    if (this.valveOpenedTime === undefined) {
      return;
    }

    let duration = Math.floor(Date.now() / 1000) - this.valveOpenedTime;

    // Emit event via HomeKitDevice
    if (this.#HomeKitDeviceUUID !== undefined) {
      HomeKitDevice.message(this.#HomeKitDeviceUUID, Valve.VALVE_EVENT, {
        uuid: this.uuid,
        pin: this.#valvePin,
        status: Valve.CLOSED,
        time: Math.floor(Date.now() / 1000),
        water: this.waterAmount,
        duration: duration,
      });
    }

    this?.log?.debug?.(
      'Recorded %sL over %s seconds and average rate was %sLPM',
      this.waterAmount.toFixed(3),
      duration,
      duration > 0 ? ((this.waterAmount / duration) * 60).toFixed(3) : '0.000',
    );

    this.waterAmount = 0;
    this.valveOpenedTime = undefined;
  }

  isOpen() {
    return this.valveOpenedTime !== undefined;
  }

  getWaterUsage() {
    return this.waterAmount;
  }

  getFlowStats() {
    let duration = this.valveOpenedTime !== undefined ? Math.floor(Date.now() / 1000) - this.valveOpenedTime : 0;

    return {
      uuid: this.uuid,
      pin: this.#valvePin,
      status: this.isOpen() === true ? Valve.OPENED : Valve.CLOSED,
      time: Math.floor(Date.now() / 1000),
      usage: {
        waterLitres: this.waterAmount,
        durationSeconds: duration,
        averageLPM: duration > 0 ? Number(((this.waterAmount / duration) * 60).toFixed(3)) : 0,
      },
    };
  }

  #setupFlowSensor(deviceData) {
    let sensorFlowPin = this.#sensorFlowPin;

    if (sensorFlowPin === undefined) {
      return;
    }

    if (Valve.#flowPins[sensorFlowPin] === undefined) {
      Valve.#flowPins[sensorFlowPin] = {
        valves: new Set(),
        targets: new Set(),
        pulseCounter: 0,
        flowBuffer: [],
        lastFlowTime: Date.now(),
        flowRate: Number.isFinite(Number(deviceData?.flowRate)) === true ? Number(deviceData.flowRate) : 0,
        timer: undefined,
      };

      Valve.GPIO.open(sensorFlowPin, Valve.GPIO.INPUT, Valve.GPIO.PULL_UP);
      Valve.GPIO.poll(
        sensorFlowPin,
        () => {
          Valve.#flowPins[sensorFlowPin].pulseCounter++;
        },
        Valve.GPIO.POLL_HIGH,
      );

      Valve.#flowPins[sensorFlowPin].timer = setInterval(() => {
        this.#processFlowSensor(sensorFlowPin);
      }, 1000); // 1Hz
    }

    this?.log?.debug?.(
      'Valve "%s" using flow sensor pin "%s"%s',
      deviceData?.name,
      sensorFlowPin,
      Valve.#flowPins[sensorFlowPin].valves.size !== 0 ? ' (shared)' : '',
    );

    Valve.#flowPins[sensorFlowPin].valves.add(this);

    if (this.#HomeKitDeviceUUID !== undefined) {
      Valve.#flowPins[sensorFlowPin].targets.add(this.#HomeKitDeviceUUID);
    }
  }

  #processFlowSensor(sensorFlowPin) {
    let flowPin = Valve.#flowPins[sensorFlowPin];

    if (typeof flowPin !== 'object' || flowPin === null) {
      return;
    }

    let now = Date.now();
    let intervalDuration = now - flowPin.lastFlowTime;

    if (intervalDuration <= 0) {
      return;
    }

    flowPin.lastFlowTime = now;

    let flowRate = (flowPin.pulseCounter / (intervalDuration / 1000)) * flowPin.flowRate;
    let flowVolume = flowRate * (intervalDuration / 60000);
    flowPin.pulseCounter = 0;

    flowPin.flowBuffer.push(flowVolume);
    if (flowPin.flowBuffer.length > 5) {
      flowPin.flowBuffer.shift();
    }

    let smoothedVolume = flowPin.flowBuffer.reduce((a, b) => a + b, 0) / flowPin.flowBuffer.length;
    let openValves = [...flowPin.valves].filter((valve) => valve.valveOpenedTime !== undefined);

    openValves.forEach((valve) => {
      if (Number.isFinite(Number(smoothedVolume)) === true) {
        valve.waterAmount = valve.waterAmount + Number(smoothedVolume / openValves.length);
      }
    });

    flowPin.targets.forEach((uuid) => {
      // Emit event via HomeKitDevice
      if (this.#HomeKitDeviceUUID !== undefined) {
        HomeKitDevice.message(uuid, Valve.FLOW_EVENT, {
          time: now,
          rate: flowRate,
          volume: smoothedVolume,
        });
      }
    });
  }

  #validGPIOPin(pin) {
    return Number.isFinite(Number(pin)) === true && Number(pin) >= Valve.MIN_GPIO_PIN && Number(pin) <= Valve.MAX_GPIO_PIN;
  }
}
