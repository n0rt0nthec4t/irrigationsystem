// Code version 11/10/2024
// Mark Hulskamp
'use strict';

// Define external module requirements
import GPIO from 'rpio';

// Define nodejs module requirements
import process from 'node:process';
import { Buffer } from 'node:buffer';
import EventEmitter from 'node:events';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import WaterTank from './watertank.js';
import Valve from './valve.js';

Valve.GPIO = GPIO; // Setup the GPIO library for the valve class

const WATERLEAKTIMEOUT = 10000; // Milliseconds after a water valve is closed before we can report on any water leak
const FLOWDATABUFFER = 30000; // Milliseconds of water flow data to store. Used to determine constant leak

export default class IrrigationSystem extends HomeKitDevice {
  irrigationService = undefined; // HomeKit service for this irrigation system
  leakSensorService = undefined; // HomeKit service for a "leak" sensor
  switchService = undefined;
  lastValveClose = 0; // Last time a valve was closed
  flowData = []; // Water flow readings buffer
  activeCheck = [];
  activeCheckTimer = undefined;
  leakDetected = false; // No Water leak detected yet

  // Internal data only for this class
  #eventEmitter = undefined;
  #lastFlowTime = undefined; // Time of last flow pulse recieved
  #flowPulseCounter = undefined; // Flow sensor pulse counter
  #flowTimer = undefined;
  #pauseTimer = undefined;
  #tanks = {}; // Object for tanks we actually created
  #zones = {}; // Object for zones we actually created

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);

    // Fix 'mis-named' characteristic option until changed in hap-nodejs based code (v1.1.x has fix)
    if (this?.hap?.Characteristic?.ProgramMode?.PROGRAM_SCHEDULED_MANUAL_MODE_ !== undefined) {
      this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE = 2;
    }

    // Init the GPIO (rpio) library. This only needs to be done once before using library functions
    GPIO.init({ gpiomem: true });
    GPIO.init({ mapping: 'gpio' });

    // Validate if eventEmitter object passed to us is an instance of EventEmitter
    if (eventEmitter instanceof EventEmitter === true) {
      this.#eventEmitter = eventEmitter;
    }

    // Setup to close any opened valves if the process is stopped
    let signals = { SIGINT: 2, SIGTERM: 15 };
    Object.keys(signals).forEach((signal) => {
      process.on(signal, () => {
        this?.log?.debug && this.log.debug('Received signal to terminate process. Closing any opened values');
        Object.values(this.#zones).forEach((zone) => {
          zone.valves.forEach((valve) => {
            if (valve.isOpen() === true) {
              valve.close();
            }
          });
        });

        process.exit(128 + signals[signal]);
      });
    });
  }

  // Class functions
  addServices() {
    // Create extra details for output
    let postSetupDetails = [];

    // Setup the irrigation service if not already present on the accessory
    this.irrigationService = this.accessory.getService(this.hap.Service.IrrigationSystem);
    if (this.irrigationService === undefined) {
      this.irrigationService = this.accessory.addService(this.hap.Service.IrrigationSystem, '', 1);
    }
    this.irrigationService.setPrimaryService();

    // Setup callbacks for characteristics
    this.irrigationService.getCharacteristic(this.hap.Characteristic.Active).onSet((value) => {
      this.#processActiveCharacteristic(this.irrigationService, value, 'system');
    });
    this.irrigationService.getCharacteristic(this.hap.Characteristic.Active).onGet(() => {
      return this.deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
    });

    // Add an optional "virtual" power switch if configured
    this.switchService = this.accessory.getService(this.hap.Service.Switch);
    if (this.deviceData?.powerSwitch === true) {
      if (this.switchService === undefined) {
        this.switchService = this.accessory.addService(this.hap.Service.Switch, '', 1);
      }
      // Setup set callback for this switch service
      this.switchService.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
        if (value !== this.deviceData.power) {
          this?.log?.info && this.log.info('Irrigation system was turned "%s"', value === true ? 'on' : 'off');

          this.set({ power: value });
        }
      });

      this.switchService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {
        return this.deviceData.power === true;
      });
    }
    if (this.switchService !== undefined && this.deviceData?.powerSwitch !== true) {
      // No longer required to have the switch service
      // This is to handle Homebridge cached restored accessories and if configuration options have changed
      this?.log?.debug && this.log.debug('Configuration has changed to no-longer have virtual power switch');
      this.accessory.removeService(this.switchService);
      this.switchService = undefined;
    }

    // Add in any defined water tanks
    if (Array.isArray(this.deviceData?.tanks) === true && this.deviceData.tanks.length > 0) {
      this?.log?.debug('Creating defined watertanks from configuration');
      this.deviceData.tanks.forEach((tank) => {
        if (tank?.enabled === true && tank?.sensorEchoPin !== undefined && tank?.sensorTrigPin !== undefined) {
          if (this.irrigationService.testCharacteristic(this.hap.Characteristic.WaterLevel) === false) {
            // We haven't added the water level characteristic yet to the irringation service
            // This added once we have the first 'enabled' water tank
            this.irrigationService.addCharacteristic(this.hap.Characteristic.WaterLevel);
          }

          this.#tanks[tank.uuid] = new WaterTank(
            this.log,
            tank.uuid,
            tank.sensorHeight,
            tank.minimumLevel,
            tank.sensorTrigPin,
            tank.sensorEchoPin,
            this.eventEmitter,
          );

          postSetupDetails.push('Watertank "' + tank.name + '" with "' + tank.capacity + '" Litres');
        }
      });
    }

    // Setup any defined "physical" and/or "virtual" irrigation zones
    if (Array.isArray(this.deviceData?.zones) === true && this.deviceData.zones.length > 0) {
      this?.log?.debug('Creating defined irrigation zones from configuration');
      this.deviceData.zones.forEach((zone, index) => {
        let tempService = this.accessory.addService(this.hap.Service.Valve, '', index + 1);
        tempService.addCharacteristic(this.hap.Characteristic.IsConfigured);
        tempService.addCharacteristic(this.hap.Characteristic.RemainingDuration);
        tempService.addCharacteristic(this.hap.Characteristic.SetDuration);
        tempService.addCharacteristic(this.hap.Characteristic.ConfiguredName);
        tempService.addCharacteristic(this.hap.Characteristic.Identifier);

        // Setup characteristic property ranges
        tempService.getCharacteristic(this.hap.Characteristic.SetDuration).setProps({ maxValue: this.deviceData.maxRuntime });
        tempService.getCharacteristic(this.hap.Characteristic.RemainingDuration).setProps({ maxValue: this.deviceData.maxRuntime });

        tempService.updateCharacteristic(this.hap.Characteristic.ValveType, this.hap.Characteristic.ValveType.IRRIGATION);
        tempService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, zone.name);
        tempService.updateCharacteristic(
          this.hap.Characteristic.IsConfigured,
          zone.enabled === true ? this.hap.Characteristic.IsConfigured.CONFIGURED : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
        );
        tempService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        tempService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        tempService.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
        tempService.updateCharacteristic(this.hap.Characteristic.SetDuration, zone.runtime);
        tempService.updateCharacteristic(this.hap.Characteristic.Identifier, crc32(zone.uuid.toUpperCase()));

        if (zone?.relayPin !== undefined && Array.isArray(zone.relayPin) === false) {
          // Since single relay pin, this is a "physical" zone
          this.#zones[zone.uuid] = {
            service: tempService,
            valves: [new Valve(this.log, zone.name, zone.relayPin, this.#eventEmitter)],
            timer: undefined,
            totalwater: 0,
            totalduration: 0,
          };
        }

        if (Array.isArray(zone?.relayPin) === true) {
          // Since relay pin in is an array, we'll treat this as a "virtual" zone
          let valveArray = [];
          zone.relayPin.forEach((relayPin) => {
            valveArray.push(new Valve(this.log, zone.name, relayPin, this.#eventEmitter));
          });
          this.#zones[zone.uuid] = {
            service: tempService,
            valves: valveArray,
            timer: undefined,
            totalwater: 0,
            totalduration: 0,
          };
        }

        // Setup callbacks for characteristics
        tempService.getCharacteristic(this.hap.Characteristic.Active).onSet((value) => {
          this.#processActiveCharacteristic(this.deviceData.zones[index], value, 'valve');
        });
        tempService.getCharacteristic(this.hap.Characteristic.ConfiguredName).onSet((value) => {
          this.setZoneName(this.deviceData.zones[index], value);
        });
        tempService.getCharacteristic(this.hap.Characteristic.IsConfigured).onSet((value) => {
          this.setZoneEnabled(this.deviceData.zones[index], value);
        });
        tempService.getCharacteristic(this.hap.Characteristic.SetDuration).onSet((value) => {
          this.setZoneRuntime(this.deviceData.zones[index], value);
        });

        tempService.getCharacteristic(this.hap.Characteristic.Active).onGet(() => {
          return this.#zones[this.deviceData.zones[index].uuid].timer === undefined
            ? this.hap.Characteristic.Active.INACTIVE
            : this.hap.Characteristic.Active.ACTIVE;
        });
        tempService.getCharacteristic(this.hap.Characteristic.ConfiguredName).onGet(() => {
          return this.deviceData.zones[index].name;
        });
        tempService.getCharacteristic(this.hap.Characteristic.SetDuration).onGet(() => {
          return this.deviceData.zones[index].runtime;
        });
        tempService.getCharacteristic(this.hap.Characteristic.IsConfigured).onGet(() => {
          return this.deviceData.zones[index].enabled === true
            ? this.hap.Characteristic.IsConfigured.CONFIGURED
            : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED;
        });

        this.irrigationService.addLinkedService(tempService); // Link to main irrigation accesssory

        postSetupDetails.push('Zone "' + zone.name + '" ' + (zone.enabled === false ? 'but disabled' : ''));
      });
    }

    // Create flow/leak sensor if configured
    if (this.deviceData?.sensorFlowPin !== undefined) {
      this?.log?.debug('Setting up water flow sensor on GPIO pin "%s"', this.deviceData.sensorFlowPin);
      // Initialise the GPIO output PINs for the flow sensor and setup a GPIO polling interrupt to count the pulses
      this.#flowPulseCounter = 0; // Reset pulse counter
      GPIO.open(this.deviceData.sensorFlowPin, GPIO.INPUT, GPIO.PULL_UP);
      GPIO.poll(
        this.deviceData.sensorFlowPin,
        () => {
          this.#flowPulseCounter++;
        },
        GPIO.POLL_HIGH,
      );

      // Setup interval to check the water flow every 1 second, which is 1Hz
      this.#lastFlowTime = Date.now(); // Start of interval
      this.#flowTimer = setInterval(() => {
        // We've got the number of pulses over a set period of time, so calculate flow rate and volume used in this period

        // Q (L/min) =  (F (Hz) / 1000) * factor (L/min)
        // V (L) = Q (L/Min) * (duration (min) )
        let intervalDuration = Date.now() - this.#lastFlowTime;
        let flowRate = (this.#flowPulseCounter / (intervalDuration / 1000)) * this.deviceData.flowRate;
        let flowVolume = flowRate * (intervalDuration / 60000);

        // Determine if flow rate calculated is "within" bounds. We use this to filter out extremes and random responses
        // <--- TODO

        // Send out an event with current water flow data
        if (this.#eventEmitter !== undefined) {
          this.#eventEmitter.emit(Valve.FLOWEVENT, {
            time: Date.now(),
            rate: flowRate,
            volume: flowVolume,
          });
        }

        this.#lastFlowTime = Date.now(); // Update process time
        this.#flowPulseCounter = 0; // Reset pulse counter
      }, 1000);
    }

    // Add an optional water leak sensor if configured
    this.leakSensorService = this.accessory.getService(this.hap.Service.LeakSensor);
    if (this.deviceData?.leakSensor === true && this.deviceData?.sensorFlowPin !== undefined) {
      // Create the HomeKit service for the leak sensor
      if (this.leakSensorService === undefined) {
        this.leakSensorService = this.accessory.addService(this.hap.Service.LeakSensor, '', 1);
      }
      this.leakSensorService.updateCharacteristic(
        this.hap.Characteristic.LeakDetected,
        this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );
    }
    if (this.leakSensorService !== undefined && (this.deviceData?.leakSensor !== true || this.deviceData?.sensorFlowPin === undefined)) {
      // No longer required to have the leak sensor service
      // This is to handle Homebridge cached restored accessories and if configuration options have changed
      this?.log?.debug && this.log.debug('Configuration has changed to no-longer have leak sensor');
      this.accessory.removeService(this.leakSensorService);
      this.leakSensorService = undefined;
    }

    // Setup timer to manage pausing and unpausing of watering
    this.#pauseTimer = setInterval(() => {
      if (this.deviceData.pauseTimeout !== 0 && Math.floor(Date.now() / 1000) >= this.deviceData.pauseTimeout) {
        // Pause timeout expired, so turn system back on
        this.setPower(true);
        this?.log?.success && this.log.success('Watering has resumed after being paused for a period');
      }
    }, 5000); // Every 5 seconds. maybe every second??

    // Setup event listeners for various events we'll want to process
    if (this.#eventEmitter !== undefined) {
      this.#eventEmitter.addListener(WaterTank.WATERLEVEL, (waterLevelData) => {
        this.messageServices(WaterTank.WATERLEVEL, waterLevelData);
      });
      this.#eventEmitter.addListener(Valve.VALVEEVENT, (valveData) => {
        this.messageServices(Valve.VALVEEVENT, valveData);
      });
      this.#eventEmitter.addListener(Valve.FLOWEVENT, (flowData) => {
        this.messageServices(Valve.FLOWEVENT, flowData);
      });
    }

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      this.irrigationService !== undefined &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.irrigationService, {
        description: this.deviceData.description,
        getcommand: this.#EveHomeGetCommand.bind(this),
        setcommand: this.#EveHomeSetCommand.bind(this),
      });
    }

    // Create extra details for output
    this.switchService !== undefined && postSetupDetails.push('Virtual power switch');
    this.deviceData?.sensorFlowPin !== undefined && postSetupDetails.push('Water flow sensor');
    this.leakSensorService !== undefined &&
      postSetupDetails.push('Leak sensor' + (this.deviceData?.waterLeakAlert === true ? 'with alerting' : ''));

    return postSetupDetails;
  }

  setPower(value) {
    // Turns the irrigation system "virtually" on or off
    this.irrigationService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE); // Not in use until we start a valve??

    if (value === 'off' || value === 'OFF' || value === false || value === this.hap.Characteristic.Active.INACTIVE) {
      // For any valves that are opened, finish them running gracefully
      this.deviceData.zones.forEach((zone) => {
        if (this.#zones?.[zone?.uuid]?.service !== undefined) {
          if (
            this.#zones[zone?.uuid].service.getCharacteristic(this.hap.Characteristic.Active).value ===
            this.hap.Characteristic.Active.ACTIVE
          ) {
            this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
          }
        }
      });

      this.irrigationService.updateCharacteristic(
        this.hap.Characteristic.ProgramMode,
        this.hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
      );
      this.irrigationService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);

      this.deviceData.power = false;
    }

    if (value === 'on' || value === 'ON' || value === true || value === this.hap.Characteristic.Active.ACTIVE) {
      this.irrigationService.updateCharacteristic(
        this.hap.Characteristic.ProgramMode,
        this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE,
      );
      this.irrigationService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);

      this.deviceData.power = true;
    }

    this.set({ power: this.deviceData.power });

    this?.log?.info && this.log.info('Irrigation system was turned "%s"', this.deviceData.power === true ? 'On' : 'Off');
  }

  setZoneName(zone, value) {
    if (typeof zone !== 'object' || typeof value !== 'string' || value === '' || typeof this.#zones?.[zone?.uuid] !== 'object') {
      return;
    }

    this?.log?.debug && this.log.debug('Setting irrigation zone name from "%s" to "%s"', zone.name, value);

    zone.name = value;
    this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, value);

    // Save updated current configuration
    this.set({ zone: zone });
  }

  setZoneEnabled(zone, value) {
    if (
      typeof zone !== 'object' ||
      (typeof value !== 'boolean' &&
        value !== this.hap.Characteristic.IsConfigured.CONFIGURED &&
        value !== this.hap.Characteristic.IsConfigured.NOT_CONFIGURED) ||
      typeof this.#zones?.[zone?.uuid] !== 'object'
    ) {
      return;
    }

    this?.log?.debug &&
      this.log.debug(
        'Setting irrigation zone "%s" status from "%s" to "%s"',
        zone.name,
        zone.enabled === true ? 'Enabled' : 'Disabled',
        value === this.hap.Characteristic.IsConfigured.CONFIGURED || value === true ? 'Enabled' : 'Disabled',
      );

    // If we're making the zone 'disabled' and if the zone is currently active, stop it first
    if (value === this.hap.Characteristic.IsConfigured.NOT_CONFIGURED || value === false) {
      if (
        this.#zones[zone.uuid].service.getCharacteristic(this.hap.Characteristic.Active).value === this.hap.Characteristic.Active.ACTIVE
      ) {
        this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
      }
    }

    zone.enabled = value === this.hap.Characteristic.IsConfigured.CONFIGURED || value === true ? true : false;
    this.#zones[zone.uuid].service.updateCharacteristic(
      this.hap.Characteristic.IsConfigured,
      value === this.hap.Characteristic.IsConfigured.CONFIGURED || value === true
        ? this.hap.Characteristic.IsConfigured.CONFIGURED
        : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
    );

    // Save updated current configuration
    this.set({ zone: zone });
  }

  setZoneRuntime(zone, value) {
    if (typeof zone !== 'object' || isNaN(value) === true || typeof this.#zones?.[zone?.uuid] !== 'object') {
      return;
    }

    this?.log?.debug && this.log.debug('Setting irrigation zone "%s", runtime from "%s" to "%s" seconds', zone.name, zone.runtime, value);

    zone.runtime = value;
    this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.SetDuration, value);

    // Save updated current configuration
    this.set({ zone: zone });
  }

  setZoneActive(zone, value) {
    if (
      typeof zone !== 'object' ||
      (typeof value !== 'boolean' &&
        value !== this.hap.Characteristic.Active.ACTIVE &&
        value !== this.hap.Characteristic.Active.INACTIVE) ||
      typeof this.#zones?.[zone?.uuid] !== 'object' ||
      zone?.enabled !== true
    ) {
      return;
    }

    if (this.deviceData.power === true && (value === this.hap.Characteristic.Active.ACTIVE || value === true)) {
      // Request to turn on sprinkler and the irrigation system is 'powered on'
      // If there are any zones currently running, cancel them first
      if (this.#numberRunningZones() !== 0) {
        this.deviceData.zones.forEach((zone) => {
          if (this.#zones?.[zone?.uuid]?.service !== undefined) {
            if (
              this.#zones[zone?.uuid].service.getCharacteristic(this.hap.Characteristic.Active).value ===
              this.hap.Characteristic.Active.ACTIVE
            ) {
              this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
            }
          }
        });
      }

      this.#zones[zone.uuid].totalwater = 0; // No water usage yet for the zone this time
      this.#zones[zone.uuid].totalduration = 0; // No run duration for the water amount yet

      if (Array.isArray(this.#zones[zone.uuid].valves) === true && this.#zones[zone.uuid].valves.length > 0) {
        // Whether we have a "physical" or "virtual" zone, we'll open the first valve in the list
        this.#zones[zone.uuid].valves[0].open();
      }

      this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
      this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
      this.#zones[zone.uuid].service.updateCharacteristic(
        this.hap.Characteristic.RemainingDuration,
        this.#zones[zone.uuid].service.getCharacteristic(this.hap.Characteristic.SetDuration).value,
      );

      // Calculate the end time for the zone running, then sen
      let endTime =
        Math.floor(Date.now() / 1000) + this.#zones[zone.uuid].service.getCharacteristic(this.hap.Characteristic.SetDuration).value;
      this.#zones[zone.uuid].timer = setInterval(() => {
        if (Math.floor(Date.now() / 1000) < endTime) {
          this.#zones[zone.uuid].service.updateCharacteristic(
            this.hap.Characteristic.RemainingDuration,
            endTime - Math.floor(Date.now() / 1000),
          ); // Update HomeKit with remaining duration for zone

          this.#zones[zone.uuid].valves.forEach((valve, index) => {
            if (valve.isOpen() === true) {
              // Calculate the remaining time for this valve
              let zoneEndTime =
                endTime -
                (this.#zones[zone.uuid].service.getCharacteristic(this.hap.Characteristic.SetDuration).value /
                  this.#zones[zone.uuid].valves.length) *
                  (this.#zones[zone.uuid].valves.length - index - 1);
              if (Math.floor(Date.now() / 1000) >= zoneEndTime && index < this.#zones[zone.uuid].valves.length - 1) {
                // Reached end of the time for this valve, so stop it and start the next in line
                valve.close();
                this.#zones[zone.uuid].valves[index + 1].open(); // Open the next valve in the list
              }
            }
          });
        }

        if (Math.floor(Date.now() / 1000) > endTime) {
          // Zone runtime has finished, so make zone inactive
          // Call back into this function to turn off the zone, as it'll do all the valve closing etc
          this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
        }
      }, 1000);
    }

    if (this.deviceData.power === false && (value === this.hap.Characteristic.Active.ACTIVE || value === true)) {
      // Request to turn on sprinkler but the irrigation system is 'powered off'
      // Work around is set state of the requested valve back to off after a short duration (500ms)
      setTimeout(() => {
        clearInterval(this.#zones[zone.uuid].timer); // Cancel any zone running timer
        this.#zones[zone.uuid].timer = undefined;
        this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
      }, 500);
    }

    if (this.deviceData.power === true && (value === this.hap.Characteristic.Active.INACTIVE || value === false)) {
      // Request to turn off sprinkler and the irrigation system is 'powered on'
      clearInterval(this.#zones[zone.uuid].timer); // Cancel any zone running timer
      this.#zones[zone.uuid].timer = undefined;
      this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
      this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
      this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);

      // Work out which "valve(s)" associated with the zone are opened, and close them
      this.#zones[zone.uuid].valves.forEach((valve) => {
        if (valve.isOpen() === true) {
          valve.close();
        }
      });
    }
  }

  messageServices(type, message) {
    if (type === Valve.WATERLEVEL) {
      // Water tank level event, so update total water percentage
      // <---- TODO Need to "smooth" our readings to eliminate random reading
      let totalPercentage = 0;
      Object.values(this.#tanks).forEach((tank) => {
        totalPercentage = totalPercentage + tank.percentage;
      });
      if (totalPercentage > 100) {
        totalPercentage = 100;
      }

      this.irrigationService.updateCharacteristic(this.hap.Characteristic.WaterLevel, totalPercentage);

      if (typeof this.historyService?.addHistory === 'function') {
        this.historyService.addHistory(
          this.hap.Characteristic.WaterLevel,
          { time: Math.floor(Date.now() / 1000), level: totalPercentage },
          600,
        );
      }
    }

    if (type === Valve.FLOWEVENT && message?.time !== undefined) {
      // Water flow data, we can use this to determine if have a leaking system
      this.flowData.push(message);
      if (isNaN(this.flowData?.[0]?.time) === false && message.time - this.flowData[0].time > FLOWDATABUFFER) {
        // Stored the maximum time period in our flow data buffer, so remove the first element
        this.flowData.shift();
      }

      if (this.leakSensorService !== undefined) {
        let nonZeroVolume = this.flowData.filter((flow) => flow.volume !== 0).length;
        if (this.#numberRunningZones() === 0 && (nonZeroVolume / this.flowData.length) * 100 > 80) {
          if (
            this.lastValveClose === 0 ||
            (this.lastValveClose !== 0 && Math.floor(Date.now() / 1000) - this.lastValveClose > WATERLEAKTIMEOUT)
          ) {
            // There are no valves opened and we're calculated that the flow data buffer for the period
            // has logged over 80% water volume figures which are not zero
            if (this.leakDetected === false) {
              this.leakDetected = true; // Suspected water leak
              if (typeof this.historyService?.addHistory === 'function') {
                this.historyService.addHistory(this.leakSensorService, {
                  time: Math.floor(Date.now() / 1000),
                  status: 1,
                }); // Leak detected
              }

              if (this.deviceData.waterLeakAlert === true) {
                // Trigger HomeKit leak sensor if configured todo so
                this.leakSensorService.updateCharacteristic(
                  this.hap.Characteristic.LeakDetected,
                  this.hap.Characteristic.LeakDetected.LEAK_DETECTED,
                );
              }

              this?.log?.warn && this.log.warn('Detected suspected water leak on irrigation system');
            }
          }
        }
        if (this.#numberRunningZones() === 0 && nonZeroVolume === 0) {
          // We've previously flagged a leak and it now looks like we're no longer reporting one, so clear the leak sensor status
          if (this.leakDetected === true) {
            this.leakDetected = false; // No longer detected water leak
            if (typeof this.historyService?.addHistory === 'function') {
              this.historyService.addHistory(this.leakSensorService, {
                time: Math.floor(Date.now() / 1000),
                status: 0,
              }); // Leak not detected
            }
            this.leakSensorService.updateCharacteristic(
              this.hap.Characteristic.LeakDetected,
              this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
            );

            this?.log?.success && this.log.success('Suspected water leak no longer detected on irrigation system');
          }
        }
      }
    }

    if (type === Valve.VALVEEVENT && message?.uuid !== undefined) {
      // Map our valve message uuid, back to a zone uuid
      let associatedZone = undefined;
      this.deviceData.zones.forEach((zone) => {
        if (this.#zones[zone.uuid].valves.filter((valve) => valve?.uuid === message.uuid).length !== 0) {
          associatedZone = zone;
        }
      });

      if (message.status === Valve.Status.OPENED && this.#zones?.[associatedZone?.uuid] !== undefined) {
        if (this.#zones[associatedZone.uuid].timer === undefined) {
          if (typeof this.historyService?.addHistory === 'function') {
            // Log zone opened to history service if present
            this.historyService.addHistory(this.#zones[associatedZone.uuid].service, {
              time: message.time,
              status: 1,
              water: 0,
              duration: 0,
            });
          }

          this?.log?.info && this.log.info('Zone "%s" was turned "on"', associatedZone.name);
        }
      }

      if (message.status === Valve.Status.CLOSED && this.#zones?.[associatedZone?.uuid] !== undefined) {
        this.lastValveClose = message.time;
        this.#zones[associatedZone.uuid].totalwater = this.#zones[associatedZone.uuid].totalwater + message.water; // Add to running total for water usage
        this.#zones[associatedZone.uuid].totalduration = this.#zones[associatedZone.uuid].totalduration + message.duration; // Add to running total for time
        if (this.#zones[associatedZone.uuid].timer === undefined) {
          // Since the zone doesn't not have an active runnign timer, we assume all valves associated with the zone have finished
          if (typeof this.historyService?.addHistory === 'function') {
            // Log zone closed to history service if present
            this.historyService.addHistory(this.#zones[associatedZone.uuid].service, {
              time: message.time,
              status: 0,
              water: this.#zones[associatedZone.uuid].totalwater,
              duration: this.#zones[associatedZone.uuid].totalduration,
            });
          }

          this?.log?.info && this.log.info('Zone "%s" was turned "off"', associatedZone.name);
        }
      }
    }
  }

  #numberRunningZones() {
    let activeZoneCount = 0;

    Object.values(this.#zones).forEach((zone) => {
      if (zone.service.getCharacteristic(this.hap.Characteristic.Active).value === this.hap.Characteristic.Active.ACTIVE) {
        activeZoneCount++;
      }
    });
    return activeZoneCount;
  }

  #numberEnabledZones() {
    let enabledZoneCount = 0;

    Object.values(this.#zones).forEach((zone) => {
      if (zone.service.getCharacteristic(this.hap.Characteristic.IsConfigured).value === this.hap.Characteristic.IsConfigured.CONFIGURED) {
        enabledZoneCount++;
      }
    });
    return enabledZoneCount;
  }

  #processActiveCharacteristic(context, value, type) {
    // workaround for using hey siri to turn on/off system and valves triggering active avents along with system active event
    // Seems we get a system active event and valve events for all configured "enabled" valves when we ask siri to turn on/off
    // the irrigation system. If we just turn on a valve and the system is not active, we get a "system" and "valve" event
    this.activeCheck.push({
      context: context,
      value: value,
      type: type,
      takeaction: true,
    });

    if (this.activeCheckTimer === undefined) {
      this.activeCheckTimer = setTimeout(() => {
        let systemCount = this.activeCheck.filter(({ type }) => type === 'system' || type === 'switch').length;
        let valveCount = this.activeCheck.filter(({ type }) => type === 'valve').length;

        this.activeCheck.forEach((activeCheck) => {
          // Filter out events we don't want to action
          if (activeCheck.type === 'system' && valveCount === 1) {
            // Turned on valve when system was off (inactive)
            activeCheck.takeaction = false;
          }
          if (activeCheck.type === 'valve' && systemCount === 1 && this.#numberEnabledZones() === valveCount) {
            // Siri action to turn on/off irrigation system, so make all valve actions as false
            activeCheck.takeaction = false;
          }

          // Process callbacks
          if ((activeCheck.type === 'system' || activeCheck.type === 'switch') && activeCheck.takeaction === true) {
            this.setPower(activeCheck.value, activeCheck.callback);
          } else if ((activeCheck.type === 'system' || activeCheck.type === 'switch') && activeCheck.takeaction === false) {
            //activeCheck.callback(null); // process HomeKit callback without taking action
          }
          if (activeCheck.type === 'valve' && activeCheck.takeaction === true) {
            this.setZoneActive(activeCheck.context, activeCheck.value);
          } else if (activeCheck.type === 'valve' && activeCheck.takeaction === false) {
            // Workaround for active state of valves going to "waiting" when we don't want them to straight after the callback to HomeKit
            setTimeout(() => {
              activeCheck.context.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
              activeCheck.context.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
              activeCheck.context.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
            }, 500); // Maybe able to reduce this from 500ms???
          }
        });

        clearTimeout(this.activeCheckTimer);
        this.activeCheck = [];
        this.activeCheckTimer = undefined;
      }, 500);
    }
  }

  #EveHomeGetCommand(EveHomeGetData) {
    // Pass back extra data for Eve Aqua onGet() to process command
    // Data will already be an object, our only job is to add/modify it
    EveHomeGetData.flowrate = this.deviceData.flowrate;
    EveHomeGetData.programs = this.deviceData.programs.schedules;
    EveHomeGetData.enableschedule = this.deviceData.programs.enabled === true;
    EveHomeGetData.latitude = this.deviceData.latitude;
    EveHomeGetData.longitude = this.deviceData.longitude;
    EveHomeGetData.pause =
      this.deviceData.pauseTimeout !== 0 ? Math.round((this.deviceData.pauseTimeout - Math.floor(Date.now() / 1000)) / 86400) : 0;

    return EveHomeGetData;
  }

  #EveHomeSetCommand(EveHomeSetData) {
    if (typeof EveHomeSetData !== 'object') {
      return;
    }

    if (EveHomeSetData?.pause !== undefined) {
      // EveHome suspension scene triggered from HomeKit
      // 1 day = pause for today
      // 2 day = pause for today and tomorrow
      // get remaining seconds to midnight in our timezone (as date.now() is GMT time), then work out delay
      this.deviceData.pauseTimeout = Math.floor(
        Math.floor(Date.now() / 1000) +
          ((8.64e7 - ((Date.now() - new Date().getTimezoneOffset() * 6e4) % 8.64e7)) / 6e4) * 60 +
          (EveHomeSetData.pause - 1) * 86400,
      );

      this?.log?.warn && this.log.warn('Watering has been paused for "%s"', EveHomeSetData.pause === 1 ? 'today' : 'today and tomorrow');

      if (this.irrigationService.getCharacteristic(this.hap.Characteristic.Active).value === true) {
        this.setPower(false); // Turn off irrigation system
      }
    }

    if (EveHomeSetData?.flowrate !== undefined) {
      // Updated flowrate from Eve Home app
      this.deviceData.flowrate = EveHomeSetData.flowrate;
    }

    if (EveHomeSetData?.enable !== undefined) {
      // Schedules enabled or not
      this.deviceData.programs.enabled = EveHomeSetData.enabled;
    }

    if (EveHomeSetData?.programs !== undefined) {
      // Watering schedules
      this.deviceData.programs.schedules = EveHomeSetData.programs;
    }

    if (EveHomeSetData?.latitude !== undefined) {
      // Latitude information
      this.deviceData.latitude = EveHomeSetData.latitude;
    }
    if (EveHomeSetData?.longitude !== undefined) {
      // Longitude information
      this.deviceData.longitude = EveHomeSetData.longitude;
    }

    // Save any updated configurations
    this.set({ pauseTimeout: this.deviceData.pauseTimeout });
    this.set({
      options: {
        flowRate: this.deviceData.flowRate,
        latitude: this.deviceData.latitude,
        longitude: this.deviceData.longitude,
      },
    });
    this.set({
      programs: {
        enabled: this.deviceData.programs.enabled,
        schedules: this.deviceData.programs.schedules,
      },
    });
  }
}

// General helper functions which don't need to be part of an object class
function crc32(valueToHash) {
  let crc32HashTable = [
    0x000000000, 0x077073096, -0x11f19ed4, -0x66f6ae46, 0x0076dc419, 0x0706af48f, -0x169c5acb, -0x619b6a5d, 0x00edb8832, 0x079dcb8a4,
    -0x1f2a16e2, -0x682d2678, 0x009b64c2b, 0x07eb17cbd, -0x1847d2f9, -0x6f40e26f, 0x01db71064, 0x06ab020f2, -0xc468eb8, -0x7b41be22,
    0x01adad47d, 0x06ddde4eb, -0xb2b4aaf, -0x7c2c7a39, 0x0136c9856, 0x0646ba8c0, -0x29d0686, -0x759a3614, 0x014015c4f, 0x063066cd9,
    -0x5f0c29d, -0x72f7f20b, 0x03b6e20c8, 0x04c69105e, -0x2a9fbe1c, -0x5d988e8e, 0x03c03e4d1, 0x04b04d447, -0x2df27a03, -0x5af54a95,
    0x035b5a8fa, 0x042b2986c, -0x2444362a, -0x534306c0, 0x032d86ce3, 0x045df5c75, -0x2329f231, -0x542ec2a7, 0x026d930ac, 0x051de003a,
    -0x3728ae80, -0x402f9eea, 0x021b4f4b5, 0x056b3c423, -0x30456a67, -0x47425af1, 0x02802b89e, 0x05f058808, -0x39f3264e, -0x4ef416dc,
    0x02f6f7c87, 0x058684c11, -0x3e9ee255, -0x4999d2c3, 0x076dc4190, 0x001db7106, -0x672ddf44, -0x102aefd6, 0x071b18589, 0x006b6b51f,
    -0x60401b5b, -0x17472bcd, 0x07807c9a2, 0x00f00f934, -0x69f65772, -0x1ef167e8, 0x07f6a0dbb, 0x0086d3d2d, -0x6e9b9369, -0x199ca3ff,
    0x06b6b51f4, 0x01c6c6162, -0x7a9acf28, -0xd9dffb2, 0x06c0695ed, 0x01b01a57b, -0x7df70b3f, -0xaf03ba9, 0x065b0d9c6, 0x012b7e950,
    -0x74414716, -0x3467784, 0x062dd1ddf, 0x015da2d49, -0x732c830d, -0x42bb39b, 0x04db26158, 0x03ab551ce, -0x5c43ff8c, -0x2b44cf1e,
    0x04adfa541, 0x03dd895d7, -0x5b2e3b93, -0x2c290b05, 0x04369e96a, 0x0346ed9fc, -0x529877ba, -0x259f4730, 0x044042d73, 0x033031de5,
    -0x55f5b3a1, -0x22f28337, 0x05005713c, 0x0270241aa, -0x41f4eff0, -0x36f3df7a, 0x05768b525, 0x0206f85b3, -0x46992bf7, -0x319e1b61,
    0x05edef90e, 0x029d9c998, -0x4f2f67de, -0x3828574c, 0x059b33d17, 0x02eb40d81, -0x4842a3c5, -0x3f459353, -0x12477ce0, -0x65404c4a,
    0x003b6e20c, 0x074b1d29a, -0x152ab8c7, -0x622d8851, 0x004db2615, 0x073dc1683, -0x1c9cf4ee, -0x6b9bc47c, 0x00d6d6a3e, 0x07a6a5aa8,
    -0x1bf130f5, -0x6cf60063, 0x00a00ae27, 0x07d079eb1, -0xff06cbc, -0x78f75c2e, 0x01e01f268, 0x06906c2fe, -0x89da8a3, -0x7f9a9835,
    0x0196c3671, 0x06e6b06e7, -0x12be48a, -0x762cd420, 0x010da7a5a, 0x067dd4acc, -0x6462091, -0x71411007, 0x017b7be43, 0x060b08ed5,
    -0x29295c18, -0x5e2e6c82, 0x038d8c2c4, 0x04fdff252, -0x2e44980f, -0x5943a899, 0x03fb506dd, 0x048b2364b, -0x27f2d426, -0x50f5e4b4,
    0x036034af6, 0x041047a60, -0x209f103d, -0x579820ab, 0x0316e8eef, 0x04669be79, -0x349e4c74, -0x43997ce6, 0x0256fd2a0, 0x05268e236,
    -0x33f3886b, -0x44f4b8fd, 0x0220216b9, 0x05505262f, -0x3a45c442, -0x4d42f4d8, 0x02bb45a92, 0x05cb36a04, -0x3d280059, -0x4a2f30cf,
    0x02cd99e8b, 0x05bdeae1d, -0x649b3d50, -0x139c0dda, 0x0756aa39c, 0x0026d930a, -0x63f6f957, -0x14f1c9c1, 0x072076785, 0x005005713,
    -0x6a40b57e, -0x1d4785ec, 0x07bb12bae, 0x00cb61b38, -0x6d2d7165, -0x1a2a41f3, 0x07cdcefb7, 0x00bdbdf21, -0x792c2d2c, -0xe2b1dbe,
    0x068ddb3f8, 0x01fda836e, -0x7e41e933, -0x946d9a5, 0x06fb077e1, 0x018b74777, -0x77f7a51a, -0xf09590, 0x066063bca, 0x011010b5c,
    -0x709a6101, -0x79d5197, 0x0616bffd3, 0x0166ccf45, -0x5ff51d88, -0x28f22d12, 0x04e048354, 0x03903b3c2, -0x5898d99f, -0x2f9fe909,
    0x04969474d, 0x03e6e77db, -0x512e95b6, -0x2629a524, 0x040df0b66, 0x037d83bf0, -0x564351ad, -0x2144613b, 0x047b2cf7f, 0x030b5ffe9,
    -0x42420de4, -0x35453d76, 0x053b39330, 0x024b4a3a6, -0x452fc9fb, -0x3228f96d, 0x054de5729, 0x023d967bf, -0x4c9985d2, -0x3b9eb548,
    0x05d681b02, 0x02a6f2b94, -0x4bf441c9, -0x3cf3715f, 0x05a05df1b, 0x02d02ef8d,
  ];
  let crc32 = 0xffffffff; // init crc32 hash;
  valueToHash = Buffer.from(valueToHash); // convert value into buffer for processing
  for (let index = 0; index < valueToHash.length; index++) {
    crc32 = (crc32HashTable[(crc32 ^ valueToHash[index]) & 0xff] ^ (crc32 >>> 8)) & 0xffffffff;
  }
  crc32 ^= 0xffffffff;
  return crc32 >>> 0; // return crc32
}
