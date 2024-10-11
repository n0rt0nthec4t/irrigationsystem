// Code version 11/10/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import crypto from 'node:crypto';

export default class Valve {
  static GPIO = undefined; // GPIO library override
  static FLOWEVENT = 'FLOWEVENT'; // Water flow event tag
  static VALVEEVENT = 'VALVEEVENT'; // Valve event tag
  static Status = {
    OPENED: 'opened',
    CLOSED: 'closed',
  };

  valveOpenedTime = undefined; // Time valve was opened
  waterAmount = undefined; // Water usage during valve open period

  // Internal data only for this class
  #eventEmitter = undefined;
  #GPIO_ValvePin = undefined; // GPIO pin on which valve can be operated on

  constructor(log, zoneName, GPIO_ValvePin, eventEmitter) {
    // Validate if eventEmitter object passed to us is an instance of EventEmitter
    if (eventEmitter instanceof EventEmitter === true) {
      this.#eventEmitter = eventEmitter;
      this.#eventEmitter.setMaxListeners(this.#eventEmitter.getMaxListeners() + 1);
    }

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

    this.uuid = crypto.randomUUID();

    this.#GPIO_ValvePin =
      isNaN(GPIO_ValvePin) === false && Number(GPIO_ValvePin) >= 0 && Number(GPIO_ValvePin) <= 26 ? Number(GPIO_ValvePin) : undefined;

    if (this.#GPIO_ValvePin === undefined) {
      this?.log?.warn && this.log.warn('No relay pin specifed for irrigation zone valve "%s"', zoneName);
    }

    if (Valve.GPIO === undefined) {
      this?.log?.error && this.log.error('No GPIO library has been specifed for this class. Valves cannot be operated via hardware');
    }

    if (this.#GPIO_ValvePin !== undefined && Valve.GPIO !== undefined) {
      this?.log?.debug && this.log.debug('Setting up irrigation zone valve "%s" using relay pin "%s"', zoneName, this.#GPIO_ValvePin);

      // Initialise the GPIO output PINs for this valve
      Valve.GPIO.open(this.#GPIO_ValvePin, Valve.GPIO.OUTPUT, Valve.GPIO.LOW); // Set valve status as closed for default

      if (this.#eventEmitter !== undefined) {
        this.#eventEmitter.addListener(Valve.FLOWEVENT, (flowData) => {
          // We'll action any water flow events here. If valve is opened, we'll add the flow figures to the usage amount
          if (this.valveOpenedTime !== undefined && isNaN(flowData?.volume) === false) {
            this.waterAmount = this.waterAmount + Number(flowData.volume);
          }
        });
      }
    }
  }

  open() {
    if (this.#GPIO_ValvePin === undefined) {
      return;
    }

    this?.log?.debug && this.log.debug('Receieved request to open irrigation valve on relay pin "%s"', this.#GPIO_ValvePin);

    if (Valve.GPIO !== undefined) {
      // Output a high signal on the GPIO, this will trigger the connected relay to open
      Valve.GPIO.write(this.#GPIO_ValvePin, Valve.GPIO.HIGH);
    }

    this.valveOpenedTime = Math.floor(Date.now() / 1000);
    this.waterAmount = 0;

    // Send out an event with the updated valve status
    if (this.#eventEmitter !== undefined) {
      this.#eventEmitter.emit(Valve.VALVEEVENT, {
        uuid: this.uuid,
        pin: this.#GPIO_ValvePin,
        status: Valve.Status.OPENED,
        time: this.valveOpenedTime,
        water: 0,
        duration: 0,
      });
    }
  }

  close() {
    if (this.#GPIO_ValvePin === undefined) {
      return;
    }

    if (Valve.GPIO !== undefined) {
      // Output a low signal on the GPIO, this will trigger the connected relay to close
      Valve.GPIO.write(this.#GPIO_ValvePin, Valve.GPIO.LOW);
    }

    // Send out an event with the updated valve status
    let duration = this.valveOpenedTime !== undefined ? Math.floor(Date.now() / 1000) - this.valveOpenedTime : 0;
    if (this.#eventEmitter !== undefined) {
      this.#eventEmitter.emit(Valve.VALVEEVENT, {
        uuid: this.uuid,
        pin: this.#GPIO_ValvePin,
        status: Valve.Status.CLOSED,
        time: Math.floor(Date.now() / 1000),
        water: this.waterAmount,
        duration: duration,
      });
    }

    this?.log?.debug && this.log.debug('Receieved request to close irrigation valve on relay pin "%s"', this.#GPIO_ValvePin);
    this?.log?.debug &&
      this.log.debug(
        'Recorded %sL over %s seconds and average rate was %sLPM',
        this.waterAmount.toFixed(3),
        duration,
        ((this.waterAmount / duration) * 60).toFixed(3),
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
}
