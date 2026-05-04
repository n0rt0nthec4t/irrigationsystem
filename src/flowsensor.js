// FlowSensor
// Part of irrigationsystem
//
// Handles water flow measurement using a GPIO-based pulse sensor.
// Designed as a shared component that emits flow data events
// independent of valves or irrigation zones.
//
// Responsibilities:
// - Monitor GPIO pulse input for flow sensors
// - Calculate flow rate and volume
// - Apply smoothing via rolling buffer
// - Emit FLOW_EVENT via HomeKitDevice message bus
// - Perform leak detection and emit LEAK_EVENT
//
// Architecture:
// - One FlowSensor instance per GPIO pin (shared singleton per pin)
// - Additional instances attach to the existing sensor
// - Leak detection + processing always performed by the "owner" instance
//
// Events emitted:
// - FlowSensor.FLOW_EVENT -> { time, rate, volume }
// - FlowSensor.LEAK_EVENT -> { time, status, rate, volume }
//
// Requirements:
// - GPIO library must be assigned to FlowSensor.GPIO before use
// - Valid GPIO pin required
//
// Code version 2026.05.03
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { validGPIOPin, LOG_LEVELS } from './utils.js';

export default class FlowSensor {
  static GPIO = undefined; // GPIO library override
  static FLOW_EVENT = 'FLOWEVENT';
  static LEAK_EVENT = 'LEAKEVENT';

  // Track all active sensors by pin (single owner per pin)
  static #sensors = {};

  uuid = undefined; // Unique identifier for this flow sensor instance

  #HomeKitDeviceUUID = undefined;
  #sensorPin = undefined;
  #targets = new Set();
  #pulseCounter = 0;
  #flowBuffer = [];
  #lastFlowTime = Date.now();
  #flowRate = 0;
  #timer = undefined;
  #leakEnabled = false;
  #leakDetected = false;
  #lastExpectedFlowTime = 0;
  #flowExpected = false;
  #leakTimeout = 10000;
  #flowData = [];

  constructor(log = undefined, uuid = undefined, deviceData = {}) {
    // Validate the passed in logging object. We are expecting certain functions to be present
    if (Object.values(LOG_LEVELS).every((fn) => typeof log?.[fn] === 'function')) {
      this.log = log;
    }

    this.#HomeKitDeviceUUID = typeof uuid === 'string' && uuid !== '' ? uuid : undefined;

    this.uuid = typeof deviceData?.uuid === 'string' && deviceData.uuid !== '' ? deviceData.uuid : crypto.randomUUID();

    this.#setupFlowSensor(deviceData);
  }

  onUpdate(deviceData = {}) {
    if (typeof deviceData !== 'object' || deviceData === null) {
      return;
    }

    // Sensor pin changes require reinitialising GPIO polling.
    // Do this first so any supplied flowRate/leakDetection/leakTimeout settings
    // are applied to the new owner sensor below.
    if (Object.hasOwn(deviceData, 'sensorPin') === true) {
      let newPin = validGPIOPin(deviceData.sensorPin) === true ? Number(deviceData.sensorPin) : undefined;

      if (newPin !== this.#sensorPin) {
        this.onShutdown();

        // Reset runtime state before attaching to the new pin.
        this.#sensorPin = undefined;
        this.#pulseCounter = 0;
        this.#flowBuffer = [];
        this.#flowData = [];
        this.#lastFlowTime = Date.now();
        this.#lastExpectedFlowTime = 0;
        this.#leakDetected = false;
        this.#flowExpected = false;

        this.#setupFlowSensor(deviceData);
      }
    }

    // Updates must be applied to the owner instance for this GPIO pin.
    // If this instance attached to an existing sensor, the owner holds the timer,
    // flow buffer, pulse counter, leak state, and registered targets.
    let sensor = FlowSensor.#sensors[this.#sensorPin] ?? this;

    // Flow rate calibration can be safely changed live.
    // Only update it when explicitly supplied AND changed so we avoid noisy logs.
    if (Object.hasOwn(deviceData, 'flowRate') === true) {
      if (Number.isFinite(Number(deviceData.flowRate)) === true) {
        let newRate = Number(deviceData.flowRate);

        if (newRate !== sensor.#flowRate) {
          this?.log?.debug?.(
            'Updating flow rate calibration for sensor on pin "%s" from "%s" to "%s" litres/pulse',
            this.#sensorPin,
            sensor.#flowRate,
            newRate,
          );

          sensor.#flowRate = newRate;
        }
      }
    }

    // Leak detection can be enabled/disabled live.
    // Only update it when explicitly supplied so partial updates do not
    // accidentally disable leak detection.
    if (Object.hasOwn(deviceData, 'leakDetection') === true) {
      let enabled = deviceData.leakDetection === true;

      if (enabled !== sensor.#leakEnabled) {
        this.log?.debug?.(
          'Updating leak detection for sensor on pin "%s" to "%s"',
          this.#sensorPin,
          enabled === true ? 'enabled' : 'disabled',
        );

        sensor.#leakEnabled = enabled;

        // Reset leak state and buffered flow data when leak detection is disabled
        // so stale samples cannot trigger an old leak state if re-enabled later.
        if (enabled === false) {
          sensor.#leakDetected = false;
          sensor.#flowData = [];
        }
      }
    }
  }

  onShutdown() {
    if (this.#sensorPin === undefined || FlowSensor.#sensors[this.#sensorPin] === undefined) {
      return;
    }

    // Detach this HomeKitDevice target from the owner sensor.
    // The owner may be this instance or another shared instance for the same pin.
    let sensorPin = this.#sensorPin;
    let sensor = FlowSensor.#sensors[sensorPin];

    sensor.#targets.delete(this.#HomeKitDeviceUUID);

    // This instance is no longer attached to the sensor.
    this.#sensorPin = undefined;

    // Keep GPIO polling active while at least one target still uses this sensor.
    if (sensor.#targets.size !== 0) {
      return;
    }

    // No remaining users for this pin, so stop the timer and remove GPIO polling.
    clearInterval(sensor.#timer);
    sensor.#timer = undefined;

    try {
      FlowSensor.GPIO?.poll?.(sensorPin, null);
    } catch {
      // Empty
    }

    // Remove owner from shared registry and clear owner runtime state.
    delete FlowSensor.#sensors[sensorPin];

    sensor.#sensorPin = undefined;
    sensor.#pulseCounter = 0;
    sensor.#flowBuffer = [];
    sensor.#flowData = [];
    sensor.#lastExpectedFlowTime = 0;
    sensor.#leakDetected = false;
    sensor.#flowExpected = false;

    this?.log?.debug?.('Closing flow sensor on GPIO pin "%s"', sensorPin);
  }

  markExpectedFlow(value = true) {
    let sensor = FlowSensor.#sensors[this.#sensorPin] ?? this;

    let newState = value === true;

    // Only act if state actually changes
    if (newState === sensor.#flowExpected) {
      return;
    }

    sensor.#flowExpected = newState;

    // Flow state changed, so reset the leak detector reference time.
    sensor.#lastExpectedFlowTime = Date.now();

    if (sensor.#flowExpected === true) {
      // Clear buffered samples
      sensor.#flowData = [];

      // Clear active leak state immediately
      if (sensor.#leakDetected === true) {
        sensor.#leakDetected = false;

        sensor.#targets.forEach((uuid) => {
          if (typeof uuid === 'string' && uuid !== '') {
            HomeKitDevice.message(uuid, FlowSensor.LEAK_EVENT, {
              uuid: sensor.uuid,
              pin: sensor.#sensorPin,
              time: sensor.#lastExpectedFlowTime,
              status: 0,
              rate: 0,
              volume: 0,
            });
          }
        });
      }
    }
  }

  setLeakDetectionEnabled(value = true) {
    let sensor = FlowSensor.#sensors[this.#sensorPin] ?? this;
    sensor.#leakEnabled = value === true;
  }

  isLeaking() {
    let sensor = FlowSensor.#sensors[this.#sensorPin] ?? this;
    return sensor.#leakDetected === true;
  }

  #setupFlowSensor(deviceData = {}) {
    let sensorPin = validGPIOPin(deviceData?.sensorPin) === true ? Number(deviceData.sensorPin) : undefined;

    if (sensorPin === undefined) {
      this?.log?.warn?.('No sensor pin specified for flow sensor');
      return;
    }

    if (FlowSensor.GPIO === undefined) {
      this?.log?.error?.('No GPIO library has been specified for this class. Flow sensors cannot be operated via hardware');
      return;
    }

    this.#sensorPin = sensorPin;

    // Reuse an existing sensor owner for this GPIO pin.
    // Only the owner keeps the pulse counter, polling callback, timer, and buffers.
    // This instance only registers its HomeKitDevice UUID as another target.
    let existing = FlowSensor.#sensors[this.#sensorPin];

    if (existing !== undefined) {
      if (this.#HomeKitDeviceUUID !== undefined) {
        existing.#targets.add(this.#HomeKitDeviceUUID);
      }

      existing.onUpdate(deviceData);

      this?.log?.debug?.('Flow sensor using GPIO pin "%s" (shared)', this.#sensorPin);
      return;
    }

    // This is the first instance for this GPIO pin, so it becomes the owner.
    this.#flowRate = Number.isFinite(Number(deviceData?.flowRate)) === true ? Number(deviceData.flowRate) : 0;
    this.#leakEnabled = deviceData?.leakDetection === true;

    if (Number.isFinite(Number(deviceData?.leakTimeout)) === true) {
      this.#leakTimeout = Number(deviceData.leakTimeout);
    }

    // Register this HomeKit device as a target for flow/leak events and ensure
    // shutdown is routed back to this instance for cleanup.
    if (this.#HomeKitDeviceUUID !== undefined) {
      this.#targets.add(this.#HomeKitDeviceUUID);
      HomeKitDevice.message(this.#HomeKitDeviceUUID, HomeKitDevice.SHUTDOWN, this);
    }

    this?.log?.debug?.('Setting up flow sensor on GPIO pin "%s"', this.#sensorPin);

    // Configure the GPIO pin as an input using pull-up, then count pulses from
    // the flow sensor using GPIO polling.
    FlowSensor.GPIO.open(this.#sensorPin, FlowSensor.GPIO.INPUT, FlowSensor.GPIO.PULL_UP);

    FlowSensor.GPIO.poll(
      this.#sensorPin,
      () => {
        this.#pulseCounter++;
      },
      FlowSensor.GPIO.POLL_HIGH,
    );

    // Process accumulated pulses once per second.
    this.#timer = setInterval(() => {
      this.#processFlow();
    }, 1000);

    // Store this instance as the shared owner for this GPIO pin.
    FlowSensor.#sensors[this.#sensorPin] = this;
  }

  #processFlow() {
    // Calculate elapsed time since last processing cycle
    // Used to convert pulse counts into rate/volume
    let now = Date.now();
    let interval = now - this.#lastFlowTime;

    // Ignore invalid or zero intervals (protects against timing glitches)
    if (interval <= 0) {
      return;
    }

    // Update last processed timestamp
    this.#lastFlowTime = now;

    // Convert pulse count into flow rate (L/min)
    // flowRate factor represents litres per pulse calibration
    let flowRate = (this.#pulseCounter / (interval / 1000)) * this.#flowRate;

    // Convert flow rate into actual volume over this interval (litres)
    let flowVolume = flowRate * (interval / 60000);

    // Reset pulse counter for next cycle
    this.#pulseCounter = 0;

    // Add volume sample to smoothing buffer
    // This helps reduce noise/spikes from sensor jitter
    this.#flowBuffer.push(flowVolume);

    // Maintain fixed buffer size (rolling window)
    if (this.#flowBuffer.length > 5) {
      this.#flowBuffer.shift();
    }

    // Median smoothing (robust against spikes)
    let sorted = [...this.#flowBuffer].sort((a, b) => a - b);
    let middle = Math.floor(sorted.length / 2);

    // Calculate smoothed volume (median of recent samples)
    let smoothedVolume = sorted.length % 2 !== 0 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

    // Build flow event payload
    // Includes raw rate and smoothed volume for downstream consumers
    let flowMessage = {
      uuid: this.uuid,
      pin: this.#sensorPin,
      time: now,
      rate: flowRate,
      volume: smoothedVolume,
    };

    // Emit flow event to all registered targets
    this.#targets.forEach((uuid) => {
      if (typeof uuid === 'string' && uuid !== '') {
        HomeKitDevice.message(uuid, FlowSensor.FLOW_EVENT, flowMessage);
      }
    });

    // Pass flow data into leak detection logic
    this.#processLeakDetection(flowMessage);
  }

  #processLeakDetection(message = {}) {
    // Leak detection is optional and requires a valid timestamp
    if (this.#leakEnabled !== true || Number.isFinite(Number(message?.time)) !== true) {
      return;
    }

    // Flow is currently expected because a zone is running.
    // Do not evaluate leak state while irrigation is active.
    if (this.#flowExpected === true) {
      return;
    }

    // Store incoming flow sample into rolling buffer
    this.#flowData.push({
      ...message,
      time: Number(message.time),
    });

    // Maintain fixed time window (30 seconds)
    while (
      this.#flowData.length > 0 &&
      Number.isFinite(Number(this.#flowData[0]?.time)) === true &&
      Number(message.time) - Number(this.#flowData[0].time) > 30000
    ) {
      this.#flowData.shift();
    }

    // Only analyse flow AFTER expected usage has stopped
    let recentFlowData = this.#flowData.filter((flow) => {
      return this.#lastExpectedFlowTime === 0 || Number(flow.time) > this.#lastExpectedFlowTime + this.#leakTimeout;
    });

    // Count samples with water movement
    let leakSamples = recentFlowData.filter((flow) => {
      return Number.isFinite(Number(flow?.volume)) === true && Number(flow.volume) > 0;
    }).length;

    // Total volume in detection window
    let leakVolume = recentFlowData.reduce((total, flow) => {
      return total + (Number.isFinite(Number(flow?.volume)) === true ? Number(flow.volume) : 0);
    }, 0);

    // Average flow rate
    let averageFlowRate =
      recentFlowData.length !== 0
        ? recentFlowData.reduce((total, flow) => {
          return total + (Number.isFinite(Number(flow?.rate)) === true ? Number(flow.rate) : 0);
        }, 0) / recentFlowData.length
        : 0;

    // Percentage of samples showing flow
    let leakPercentage = recentFlowData.length !== 0 ? (leakSamples / recentFlowData.length) * 100 : 0;

    // Leak detection trigger
    if (recentFlowData.length > 3 && leakPercentage > 60 && leakVolume > 0 && averageFlowRate > 0.2 && this.#leakDetected === false) {
      this.#leakDetected = true;

      this.#targets.forEach((uuid) => {
        if (typeof uuid === 'string' && uuid !== '') {
          HomeKitDevice.message(uuid, FlowSensor.LEAK_EVENT, {
            uuid: this.uuid,
            pin: this.#sensorPin,
            time: Number(message.time),
            status: 1,
            rate: averageFlowRate,
            volume: leakVolume,
          });
        }
      });
    }

    // Leak cleared
    if (recentFlowData.length > 3 && leakVolume === 0 && this.#leakDetected === true) {
      this.#leakDetected = false;

      this.#targets.forEach((uuid) => {
        if (typeof uuid === 'string' && uuid !== '') {
          HomeKitDevice.message(uuid, FlowSensor.LEAK_EVENT, {
            uuid: this.uuid,
            pin: this.#sensorPin,
            time: Number(message.time),
            status: 0,
            rate: 0,
            volume: 0,
          });
        }
      });
    }
  }
}
