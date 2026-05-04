// Valve
// Part of irrigationsystem
//
// Handles control of a single irrigation valve using a GPIO relay.
// Designed to operate as a lightweight relay controller within the
// HomeKitDevice messaging architecture.
//
// Responsibilities:
// - Control relay GPIO to open/close irrigation valves
// - Track valve runtime
// - Emit valve state changes via HomeKitDevice message bus
// - Respond to lifecycle shutdown events
//
// Architecture:
// - Each Valve instance is a lightweight, autonomous component
// - Communication is handled via HomeKitDevice.message(...)
// - No direct references to parent system or other valves
// - Flow sensing is handled separately by FlowSensor
//
// Events emitted:
// - Valve.VALVE_EVENT -> open/close state changes with runtime stats
//
// Lifecycle hooks used:
// - onShutdown() -> ensures valve is closed safely
//
// Requirements:
// - GPIO library must be assigned to Valve.GPIO before use
// - Relay pins must be valid GPIO numbers within defined range
//
// Code version 2026.05.01
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { validGPIOPin, LOG_LEVELS } from './utils.js';

export default class Valve {
  static GPIO = undefined; // GPIO library override
  static VALVE_EVENT = 'VALVEEVENT'; // Valve event tag

  // Valve status types
  static OPENED = 'opened';
  static CLOSED = 'closed';

  uuid = undefined; // Unique identifier for this valve instance
  valveOpenedTime = undefined; // Time valve was opened

  // Internal data only for this class
  #HomeKitDeviceUUID = undefined;
  #valvePin = undefined; // GPIO pin on which valve can be operated on

  constructor(log = undefined, uuid = undefined, deviceData = {}) {
    // Validate the passed in logging object. We are expecting certain functions to be present
    if (Object.values(LOG_LEVELS).every((fn) => typeof log?.[fn] === 'function')) {
      this.log = log;
    }

    this.#HomeKitDeviceUUID = typeof uuid === 'string' && uuid !== '' ? uuid : undefined;
    if (this.#HomeKitDeviceUUID !== undefined) {
      // Register for HomeKitDevice messages relevant to this instance (identified by UUID)
      HomeKitDevice.message(this.#HomeKitDeviceUUID, HomeKitDevice.UPDATE, this);
      HomeKitDevice.message(this.#HomeKitDeviceUUID, HomeKitDevice.SHUTDOWN, this);
    }

    this.uuid = typeof deviceData?.uuid === 'string' && deviceData.uuid !== '' ? deviceData.uuid : crypto.randomUUID();
    this.#valvePin = validGPIOPin(deviceData?.relayPin) === true ? Number(deviceData.relayPin) : undefined;

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
  }

  async onShutdown() {
    // Close the valve if it is still open to ensure safe shutdown state
    this.close();
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

    this.valveOpenedTime = Date.now();

    // Send out an event with the updated valve status
    if (this.#HomeKitDeviceUUID !== undefined) {
      HomeKitDevice.message(this.#HomeKitDeviceUUID, Valve.VALVE_EVENT, {
        uuid: this.uuid,
        pin: this.#valvePin,
        status: Valve.OPENED,
        time: this.valveOpenedTime,
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

    let now = Date.now();
    let duration = Math.max(0, Math.floor((now - this.valveOpenedTime) / 1000));

    // Send out an event with the updated valve status
    if (this.#HomeKitDeviceUUID !== undefined) {
      HomeKitDevice.message(this.#HomeKitDeviceUUID, Valve.VALVE_EVENT, {
        uuid: this.uuid,
        pin: this.#valvePin,
        status: Valve.CLOSED,
        time: now,
        duration: duration,
      });
    }

    this?.log?.debug?.('Valve on relay pin "%s" was open for "%s" seconds', this.#valvePin, duration);

    this.valveOpenedTime = undefined;
  }

  isOpen() {
    return this.valveOpenedTime !== undefined;
  }

  getStatus() {
    let now = Date.now();
    let duration = this.valveOpenedTime !== undefined ? Math.max(0, Math.floor((now - this.valveOpenedTime) / 1000)) : 0;

    return {
      uuid: this.uuid,
      pin: this.#valvePin,
      status: this.isOpen() === true ? Valve.OPENED : Valve.CLOSED,
      time: now,
      duration: duration,
    };
  }
}
