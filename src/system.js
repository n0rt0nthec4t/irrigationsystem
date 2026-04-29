// Code version 2025/06/16
// Mark Hulskamp
'use strict';

// Define external module requirements
import GPIO from 'rpio';

// Define nodejs module requirements
import { setTimeout, clearTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import WaterTank from './watertank.js';
import Valve from './valve.js';
import { crc32 } from './utils.js';

Valve.GPIO = GPIO; // Setup the GPIO library for the valve class

const WATER_LEAK_TIMEOUT = 10000; // Milliseconds after a water valve is closed before we can report on any water leak
const FLOW_DATA_BUFFER = 30000; // Milliseconds of water flow data to store. Used to determine constant leak

export default class IrrigationSystem extends HomeKitDevice {
  static TYPE = 'IrrigationSystem';
  static VERSION = '2026.04.29';

  irrigationService = undefined; // HomeKit service for this irrigation system
  leakSensorService = undefined; // HomeKit service for a "leak" sensor
  switchService = undefined;
  lastValveClose = 0; // Last time a valve was closed
  flowData = []; // Water flow readings buffer
  activeCheck = [];
  activeCheckTimer = undefined;
  leakDetected = false; // No Water leak detected yet

  // Internal data only for this class
  #tanks = {}; // Object for tanks we actually created
  #zones = {}; // Object for zones we actually created

  constructor(accessory, api, log, deviceData) {
    super(accessory, api, log, deviceData);

    // Fix 'mis-named' characteristic option until changed in hap-nodejs based code (v1.1.x has fix)
    if (this?.hap?.Characteristic?.ProgramMode?.PROGRAM_SCHEDULED_MANUAL_MODE_ !== undefined) {
      this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE = 2;
    }

    // Init the GPIO (rpio) library. This only needs to be done once before using library functions
    GPIO.init({ gpiomem: true });
    GPIO.init({ mapping: 'gpio' });
  }

  // Class functions
  onAdd() {
    // Create / get primary irrigation system service and register message handler
    this.irrigationService = this.addHKService(this.hap.Service.IrrigationSystem, '', 1, {
      messages: this.message.bind(this),
    });
    this.irrigationService.setPrimaryService();

    // Sync initial power state to HomeKit
    this.irrigationService.updateCharacteristic(
      this.hap.Characteristic.Active,
      this.deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );

    // Active characteristic (system on/off)
    this.addHKCharacteristic(this.irrigationService, this.hap.Characteristic.Active, {
      onSet: (value) => {
        this.#processActiveCharacteristic(this.irrigationService, value, 'system');
      },
      onGet: () => {
        return this.deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    // Optional virtual power switch (linked service)
    if (this.deviceData?.powerSwitch === true) {
      this.switchService = this.addHKService(this.hap.Service.Switch, '', 1);
      this.irrigationService.addLinkedService(this.switchService);

      this.addHKCharacteristic(this.switchService, this.hap.Characteristic.On, {
        onSet: (value) => {
          if (value !== this.deviceData.power) {
            this.setPower(value);
          }
        },
        onGet: () => {
          return this.deviceData.power === true;
        },
      });
    } else {
      // Remove switch if configuration no longer requires it
      this.switchService = this.accessory.getService(this.hap.Service.Switch);
      if (this.switchService !== undefined) {
        this.accessory.removeService(this.switchService);
      }
      this.switchService = undefined;
    }

    // Create water tanks (if configured)
    if (Array.isArray(this.deviceData?.tanks) === true && this.deviceData.tanks.length > 0) {
      this.log?.debug?.('Creating defined watertanks from configuration');

      for (let tank of this.deviceData.tanks) {
        if (tank?.enabled === true && tank?.sensorEchoPin !== undefined && tank?.sensorTrigPin !== undefined) {
          // Ensure WaterLevel characteristic exists on irrigation service
          if (this.irrigationService.testCharacteristic(this.hap.Characteristic.WaterLevel) === false) {
            this.irrigationService.addCharacteristic(this.hap.Characteristic.WaterLevel);
          }

          this.#tanks[tank.uuid] = new WaterTank(this.log, this.uuid, tank);
          this.postSetupDetail('Watertank "' + tank.name + '" with "' + tank.capacity + '" Litres');
        }
      }
    }

    // Create irrigation zones
    if (Array.isArray(this.deviceData?.zones) === true && this.deviceData.zones.length > 0) {
      this.log?.debug?.('Creating defined irrigation zones from configuration');

      for (let [index, zone] of this.deviceData.zones.entries()) {
        let service = this.addHKService(this.hap.Service.Valve, 'Valve ' + (index + 1), index + 1);

        // Enable / disable zone
        this.addHKCharacteristic(service, this.hap.Characteristic.IsConfigured, {
          onSet: (value) => this.setZoneEnabled(this.deviceData.zones[index], value),
          onGet: () =>
            this.deviceData.zones[index].enabled === true
              ? this.hap.Characteristic.IsConfigured.CONFIGURED
              : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
        });

        // Remaining duration (read-only, controlled by runtime)
        this.addHKCharacteristic(service, this.hap.Characteristic.RemainingDuration, {
          props: { maxValue: this.deviceData.maxRuntime },
        });

        // Set runtime duration
        this.addHKCharacteristic(service, this.hap.Characteristic.SetDuration, {
          onSet: (value) => this.setZoneRuntime(this.deviceData.zones[index], value),
          onGet: () => this.deviceData.zones[index].runtime,
          props: { maxValue: this.deviceData.maxRuntime },
        });

        // Zone name
        this.addHKCharacteristic(service, this.hap.Characteristic.ConfiguredName, {
          onSet: (value) => this.setZoneName(this.deviceData.zones[index], value),
          onGet: () => this.deviceData.zones[index].name,
        });

        // Active state (start/stop zone)
        this.addHKCharacteristic(service, this.hap.Characteristic.Active, {
          onSet: (value) => this.#processActiveCharacteristic(this.deviceData.zones[index], value, 'valve'),
          onGet: () =>
            this.#zones[this.deviceData.zones[index].uuid].timer === true
              ? this.hap.Characteristic.Active.ACTIVE
              : this.hap.Characteristic.Active.INACTIVE,
        });

        // Identifier (stable ID for HomeKit)
        this.addHKCharacteristic(service, this.hap.Characteristic.Identifier);

        // Initial characteristic state
        service.updateCharacteristic(this.hap.Characteristic.ValveType, this.hap.Characteristic.ValveType.IRRIGATION);
        service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, zone.name);
        service.updateCharacteristic(
          this.hap.Characteristic.IsConfigured,
          zone.enabled === true ? this.hap.Characteristic.IsConfigured.CONFIGURED : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
        );
        service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
        service.updateCharacteristic(this.hap.Characteristic.SetDuration, zone.runtime);
        service.updateCharacteristic(this.hap.Characteristic.Identifier, crc32(zone.uuid.toUpperCase()));

        // Build valve(s) for this zone (supports multi-relay zones)
        let relayArray = Array.isArray(zone.relayPin) === true ? zone.relayPin : [zone.relayPin];

        let valveArray = relayArray
          .filter((relayPin) => Number.isFinite(Number(relayPin)) === true)
          .map(
            (relayPin) =>
              new Valve(this.log, this.uuid, {
                uuid: zone.uuid + '-' + relayPin,
                name: zone.name,
                relayPin,
                sensorFlowPin: this.deviceData?.sensorFlowPin,
                flowRate: this.deviceData?.flowRate,
              }),
          );

        // Store internal zone state
        this.#zones[zone.uuid] = {
          service,
          valves: valveArray,
          timer: undefined,
          endTime: undefined,
          totalwater: 0,
          totalduration: 0,
        };

        this.irrigationService.addLinkedService(service);
        this.postSetupDetail('Zone "' + zone.name + '" ' + (zone.enabled === false ? 'but disabled' : ''));
      }
    }

    // Optional leak sensor setup
    if (this.deviceData?.leakSensor === true && this.deviceData?.sensorFlowPin !== undefined) {
      this.leakSensorService = this.accessory.getService(this.hap.Service.LeakSensor);

      if (this.leakSensorService === undefined) {
        this.leakSensorService = this.accessory.addService(this.hap.Service.LeakSensor, '', 1);
      }

      this.leakSensorService.updateCharacteristic(
        this.hap.Characteristic.LeakDetected,
        this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );
    } else if (this.leakSensorService !== undefined) {
      this.log?.debug?.('Configuration has changed to no-longer have leak sensor');
      this.accessory.removeService(this.leakSensorService);
      this.leakSensorService = undefined;
    }

    // Register timers
    this.addTimer('pauseCheck', { interval: 5000 }); // Resume watering after pause
    this.addTimer('zoneCheck', { interval: 1000 }); // Centralised zone runtime handler

    // Setup summary logging
    this.switchService !== undefined && this.postSetupDetail('Virtual power switch');
    this.deviceData?.sensorFlowPin !== undefined && this.postSetupDetail('Water flow sensor');
    this.leakSensorService !== undefined &&
      this.postSetupDetail('Leak sensor' + (this.deviceData?.waterLeakAlert === true ? ' with alerting' : ''));
  }

  async onTimer(message = {}) {
    if (message?.timer === 'pauseCheck') {
      if (this.deviceData.pauseTimeout !== 0 && Math.floor(Date.now() / 1000) >= this.deviceData.pauseTimeout) {
        this.setPower(true);
        this.log?.success?.('Watering has resumed after being paused for a period');
      }

      return;
    }

    if (message?.timer === 'zoneCheck') {
      // Shared 1Hz zone runtime handler.
      // Each active zone stores its own endTime and valve state; this timer only
      // advances those zones and avoids creating one setInterval per zone run.
      this.deviceData.zones.forEach((zone) => {
        if (this.#zones?.[zone?.uuid]?.timer === true) {
          this.#processZoneTimer(zone);
        }
      });
    }
  }

  async onMessage(type, message = {}) {
    if (type === WaterTank.WATERLEVEL_EVENT) {
      this.#handleWaterLevelEvent(message);
    }

    if (type === Valve.FLOW_EVENT) {
      this.#handleFlowEvent(message);
    }

    if (type === Valve.VALVE_EVENT) {
      this.#handleValveEvent(message);
    }

    if (HomeKitDevice.EVEHOME !== undefined && type === HomeKitDevice.EVEHOME.GET && typeof message === 'object' && message !== null) {
      // Pass back extra data for Eve Aqua onGet() to process command
      // Data will already be an object, our only job is to add/modify it
      message.flowrate = this.deviceData.flowRate;
      message.programs = this.deviceData.programs.schedules;
      message.enableschedule = this.deviceData.programs.enabled === true;
      message.latitude = this.deviceData.latitude;
      message.longitude = this.deviceData.longitude;
      message.pause =
        this.deviceData.pauseTimeout !== 0 ? Math.round((this.deviceData.pauseTimeout - Math.floor(Date.now() / 1000)) / 86400) : 0;

      return message;
    }

    if (HomeKitDevice.EVEHOME !== undefined && type === HomeKitDevice.EVEHOME.SET && typeof message === 'object' && message !== null) {
      if (message?.pause !== undefined) {
        // EveHome suspension scene triggered from HomeKit
        // 1 day = pause for today
        // 2 day = pause for today and tomorrow
        // get remaining seconds to midnight in our timezone (as date.now() is GMT time), then work out delay
        this.deviceData.pauseTimeout = Math.floor(
          Math.floor(Date.now() / 1000) +
            ((8.64e7 - ((Date.now() - new Date().getTimezoneOffset() * 6e4) % 8.64e7)) / 6e4) * 60 +
            (message.pause - 1) * 86400,
        );

        this?.log?.warn && this.log.warn('Watering has been paused for "%s"', message.pause === 1 ? 'today' : 'today and tomorrow');

        if (this.irrigationService.getCharacteristic(this.hap.Characteristic.Active).value === true) {
          this.setPower(false); // Turn off irrigation system
        }
      }

      if (message?.flowrate !== undefined) {
        // Updated flowrate from Eve Home app
        this.deviceData.flowRate = message.flowrate;
      }

      if (message?.enabled !== undefined) {
        // Schedules enabled or not
        this.deviceData.programs.enabled = message.enabled === true;
      }

      if (message?.programs !== undefined) {
        // Watering schedules
        this.deviceData.programs.schedules = message.programs;
      }

      if (message?.latitude !== undefined) {
        // Latitude information
        this.deviceData.latitude = message.latitude;
      }
      if (message?.longitude !== undefined) {
        // Longitude information
        this.deviceData.longitude = message.longitude;
      }

      // Save any updated configurations
      this.set({ pauseTimeout: this.deviceData.pauseTimeout });
      this.set({
        options: {
          flowrate: this.deviceData.flowRate,
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

  setPower(value) {
    // Normalise incoming power state.
    // Supports HomeKit Active enum, booleans, and legacy string values.
    let power =
      value === 'on' || value === 'ON' || value === true || value === this.hap.Characteristic.Active.ACTIVE
        ? true
        : value === 'off' || value === 'OFF' || value === false || value === this.hap.Characteristic.Active.INACTIVE
          ? false
          : undefined;

    if (power === undefined) {
      return;
    }

    // Turning the system off should gracefully stop any active zones first.
    if (power === false && Array.isArray(this.deviceData?.zones) === true) {
      this.deviceData.zones.forEach((zone) => {
        if (this.#zones?.[zone?.uuid]?.timer === true) {
          this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
        }
      });
    }

    // Update internal state.
    this.deviceData.power = power;

    // Reflect system power state in HomeKit.
    this.irrigationService.updateCharacteristic(
      this.hap.Characteristic.Active,
      power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );

    this.irrigationService.updateCharacteristic(
      this.hap.Characteristic.ProgramMode,
      power === true
        ? this.hap.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE
        : this.hap.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
    );

    this.irrigationService.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);

    // Keep optional virtual power switch in sync.
    this.switchService?.updateCharacteristic?.(this.hap.Characteristic.On, power === true);

    // Save updated current configuration.
    this.set({ power: this.deviceData.power });

    this?.log?.info?.('Irrigation system was turned "%s"', power === true ? 'on' : 'off');
  }

  setZoneName(zone, value) {
    if (
      typeof zone !== 'object' ||
      typeof value !== 'string' ||
      value.trim() === '' ||
      typeof this.#zones?.[zone?.uuid]?.service !== 'object'
    ) {
      return;
    }

    // Normalise name (trim whitespace)
    let name = value.trim();

    this?.log?.debug?.('Setting irrigation zone name from "%s" to "%s"', zone.name, name);

    // Persist internal name
    zone.name = name;

    // Reflect updated name in HomeKit
    this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, name);

    // Save updated configuration
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

    // Normalise incoming value to a boolean for internal use
    let enabled = value === true || value === this.hap.Characteristic.IsConfigured.CONFIGURED;

    this?.log?.debug &&
      this.log.debug(
        'Setting irrigation zone "%s" status from "%s" to "%s"',
        zone.name,
        zone.enabled === true ? 'Enabled' : 'Disabled',
        enabled === true ? 'Enabled' : 'Disabled',
      );

    // If disabling a zone while it is currently active, stop it first
    if (enabled === false) {
      if (this.#zones?.[zone?.uuid]?.timer === true) {
        this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
      }
    }

    // Persist internal enabled state
    zone.enabled = enabled;

    // Reflect the new state back into HomeKit
    this.#zones[zone.uuid].service.updateCharacteristic(
      this.hap.Characteristic.IsConfigured,
      enabled === true ? this.hap.Characteristic.IsConfigured.CONFIGURED : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
    );

    // Persist updated configuration
    this.set({ zone: zone });
  }

  setZoneRuntime(zone, value) {
    if (typeof zone !== 'object' || Number.isFinite(Number(value)) !== true || typeof this.#zones?.[zone?.uuid] !== 'object') {
      return;
    }

    // Clamp runtime to configured maximum before storing or reflecting it.
    let runtime = Math.min(Number(value), this.deviceData.maxRuntime);

    this?.log?.debug?.('Setting irrigation zone "%s", runtime from "%s" to "%s" seconds', zone.name, zone.runtime, runtime);

    // Persist internal runtime.
    zone.runtime = runtime;

    // Reflect updated runtime in HomeKit.
    this.#zones[zone.uuid].service.updateCharacteristic(this.hap.Characteristic.SetDuration, runtime);

    // Save updated current configuration.
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

    let zoneData = this.#zones[zone.uuid];

    if (this.deviceData.power === true && (value === this.hap.Characteristic.Active.ACTIVE || value === true)) {
      // Request to turn on sprinkler and the irrigation system is powered on.
      // Only one zone is allowed to run at a time, so stop any currently active zone first.
      if (this.#numberRunningZones() !== 0) {
        this.deviceData.zones.forEach((activeZone) => {
          if (
            this.#zones?.[activeZone?.uuid]?.service !== undefined &&
            this.#zones[activeZone.uuid].service.getCharacteristic(this.hap.Characteristic.Active).value ===
              this.hap.Characteristic.Active.ACTIVE
          ) {
            this.setZoneActive(activeZone, this.hap.Characteristic.Active.INACTIVE);
          }
        });
      }

      // Reset runtime counters for this watering run.
      zoneData.totalwater = 0;
      zoneData.totalduration = 0;

      // Whether this is a physical zone or a virtual zone with multiple relay pins,
      // always start with the first valve in the list. The timer handler will move
      // through the remaining valves as each slice of runtime expires.
      if (Array.isArray(zoneData.valves) === true && zoneData.valves.length > 0) {
        zoneData.valves[0].open();
      }

      // Mark the zone active in HomeKit.
      zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
      zoneData.service.updateCharacteristic(
        this.hap.Characteristic.RemainingDuration,
        zoneData.service.getCharacteristic(this.hap.Characteristic.SetDuration).value,
      );

      // Store timer state only.
      // Actual ticking is handled by onTimer("zoneCheck") via #processZoneTimer().
      zoneData.timer = true;
      zoneData.endTime = Math.floor(Date.now() / 1000) + zoneData.service.getCharacteristic(this.hap.Characteristic.SetDuration).value;

      return;
    }

    if (this.deviceData.power === false && (value === this.hap.Characteristic.Active.ACTIVE || value === true)) {
      // Request to turn on sprinkler while irrigation system is powered off.
      // HomeKit may briefly show the valve as active, so force it back inactive shortly after.
      setTimeout(() => {
        zoneData.timer = undefined;
        zoneData.endTime = undefined;
        zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
      }, 500);

      return;
    }

    if (this.deviceData.power === true && (value === this.hap.Characteristic.Active.INACTIVE || value === false)) {
      // Request to turn off sprinkler and the irrigation system is powered on.
      // Clear runtime state, reset HomeKit status, and close any open valves.
      zoneData.timer = undefined;
      zoneData.endTime = undefined;
      zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);

      // Work out which valve(s) associated with the zone are open and close them.
      zoneData.valves.forEach((valve) => {
        if (valve.isOpen() === true) {
          valve.close();
        }
      });
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

  #processZoneTimer(zone) {
    let zoneData = this.#zones?.[zone?.uuid];

    if (typeof zoneData !== 'object' || zoneData.timer !== true || Number.isFinite(Number(zoneData.endTime)) !== true) {
      return;
    }

    let now = Math.floor(Date.now() / 1000);

    if (now < zoneData.endTime) {
      // Update HomeKit remaining duration for this zone.
      zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, zoneData.endTime - now);

      // Virtual zones may contain multiple valves. Split the configured runtime
      // evenly across each valve and move to the next valve when its slice ends.
      zoneData.valves.forEach((valve, index) => {
        if (valve.isOpen() === true) {
          let valveEndTime =
            zoneData.endTime -
            (zoneData.service.getCharacteristic(this.hap.Characteristic.SetDuration).value / zoneData.valves.length) *
              (zoneData.valves.length - index - 1);

          if (now >= valveEndTime && index < zoneData.valves.length - 1) {
            valve.close();
            zoneData.valves[index + 1].open();
          }
        }
      });

      return;
    }

    // Zone runtime has completed, so make zone inactive through the normal path.
    this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
  }

  #handleWaterLevelEvent(message = {}) {
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof message?.uuid !== 'string' ||
      typeof this.#tanks?.[message.uuid] !== 'object'
    ) {
      return;
    }

    // Water tank level event.
    // WaterTank already smooths the reading before emitting this event, so store
    // the latest reading from the message and then aggregate all known tank levels.
    if (Number.isFinite(Number(message?.waterlevel)) === true) {
      this.#tanks[message.uuid].waterlevel = Number(message.waterlevel);
    }

    if (Number.isFinite(Number(message?.percentage)) === true) {
      this.#tanks[message.uuid].percentage = Number(message.percentage);
    }

    this.#tanks[message.uuid].lastUpdated = Date.now();

    let totalPercentage = 0;

    Object.values(this.#tanks).forEach((tank) => {
      if (Number.isFinite(Number(tank?.percentage)) === true) {
        totalPercentage = totalPercentage + Number(tank.percentage);
      }
    });

    // HomeKit WaterLevel is a single percentage value, so clamp the combined level
    // to 0-100 even when multiple tanks are configured.
    totalPercentage = Math.max(0, Math.min(100, totalPercentage));

    this.irrigationService.updateCharacteristic(this.hap.Characteristic.WaterLevel, totalPercentage);

    // Log water level history against the WaterLevel characteristic type.
    this.history(this.hap.Characteristic.WaterLevel, { time: Math.floor(Date.now() / 1000), level: totalPercentage }, 600);
  }

  #handleFlowEvent(message = {}) {
    if (typeof message !== 'object' || message === null || Number.isFinite(Number(message?.time)) !== true) {
      return;
    }

    // Water flow event.
    // Store recent flow readings so we can detect sustained flow while no zones
    // are running, which may indicate a leak.
    this.flowData.push(message);

    // Keep only the configured rolling flow window.
    while (
      this.flowData.length > 0 &&
      Number.isFinite(Number(this.flowData[0]?.time)) === true &&
      message.time - this.flowData[0].time > FLOW_DATA_BUFFER
    ) {
      this.flowData.shift();
    }

    if (this.leakSensorService !== undefined) {
      let nonZeroVolume = this.flowData.filter(
        (flow) => Number.isFinite(Number(flow?.volume)) === true && Number(flow.volume) !== 0,
      ).length;
      let nonZeroPercentage = this.flowData.length !== 0 ? (nonZeroVolume / this.flowData.length) * 100 : 0;
      let noZonesRunning = this.#numberRunningZones() === 0;
      let leakGraceExpired = this.lastValveClose === 0 || Math.floor(Date.now() / 1000) - this.lastValveClose > WATER_LEAK_TIMEOUT;

      if (noZonesRunning === true && nonZeroPercentage > 80 && leakGraceExpired === true) {
        // There are no valves open and the flow buffer contains sustained
        // non-zero flow readings, so flag a suspected leak.
        if (this.leakDetected === false) {
          this.leakDetected = true;

          this.history(this.leakSensorService, { time: Math.floor(Date.now() / 1000), status: 1 }); // Leak detected

          if (this.deviceData.waterLeakAlert === true) {
            // Trigger HomeKit leak sensor if configured to expose leak alerts.
            this.leakSensorService.updateCharacteristic(
              this.hap.Characteristic.LeakDetected,
              this.hap.Characteristic.LeakDetected.LEAK_DETECTED,
            );
          }

          this?.log?.warn?.('Detected suspected water leak on irrigation system');
        }
      }

      if (noZonesRunning === true && nonZeroVolume === 0 && this.leakDetected === true) {
        // Flow has returned to zero while no zones are running, so clear the leak state.
        this.leakDetected = false;

        this.history(this.leakSensorService, { time: Math.floor(Date.now() / 1000), status: 0 }); // Leak not detected

        this.leakSensorService.updateCharacteristic(
          this.hap.Characteristic.LeakDetected,
          this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
        );

        this?.log?.success?.('Suspected water leak no longer detected on irrigation system');
      }
    }
  }

  #handleValveEvent(message = {}) {
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof message?.uuid !== 'string' ||
      message.uuid === '' ||
      Number.isFinite(Number(message?.time)) !== true ||
      (message.status !== Valve.OPENED && message.status !== Valve.CLOSED)
    ) {
      return;
    }

    let associatedZone = undefined;

    // Resolve which zone this valve belongs to
    this.deviceData.zones.forEach((zone) => {
      if (this.#zones?.[zone.uuid]?.valves?.some((valve) => valve?.uuid === message.uuid) === true) {
        associatedZone = zone;
      }
    });

    // If we couldn't map the valve → zone, ignore event
    if (this.#zones?.[associatedZone?.uuid] === undefined) {
      return;
    }

    let zoneData = this.#zones[associatedZone.uuid];

    // Normalise optional numeric fields (protect totals from NaN)
    let water = Number.isFinite(Number(message?.water)) === true ? Number(message.water) : 0;
    let duration = Number.isFinite(Number(message?.duration)) === true ? Number(message.duration) : 0;

    if (message.status === Valve.OPENED) {
      // Only log "open" if this is not part of an active timed run
      if (zoneData.timer === undefined) {
        this.history(zoneData.service, {
          time: message.time,
          status: 1,
          water: 0,
          duration: 0,
        });

        this?.log?.info?.('Zone "%s" was turned "on"', associatedZone.name);
      }
    }

    if (message.status === Valve.CLOSED) {
      // Track last valve close time (used for leak detection grace period)
      this.lastValveClose = message.time;

      // Accumulate totals safely
      zoneData.totalwater = zoneData.totalwater + water;
      zoneData.totalduration = zoneData.totalduration + duration;

      // Only log "closed" if not part of an active timed run
      if (zoneData.timer === undefined) {
        this.history(zoneData.service, {
          time: message.time,
          status: 0,
          water: zoneData.totalwater,
          duration: zoneData.totalduration,
        });

        this?.log?.info?.('Zone "%s" was turned "off"', associatedZone.name);
      }
    }
  }

  // HTML dashboard rendering for use with HomeKitUI module.
  // Gets called when the defined dashboard page is accessed in the HomeKitUI app,
  // and returns project-specific HTML/CSS to render on the page.
  getDashboard() {
    let escapeHTML = (value) => {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#039;');
    };

    let css = `
.irrigation-dashboard .dashboard-section {
  max-width: 980px;
}

.irrigation-dashboard .dashboard-inner {
  max-width: 980px;
}

.irrigation-dashboard .dashboard-card-header {
  margin-bottom: 18px;
}

.irrigation-dashboard .dashboard-tank-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}

.irrigation-dashboard .dashboard-tank-card {
  width: 300px;
  max-width: 90%;
  padding: 20px 18px;
  text-align: center;
  margin-right: auto;
}

.irrigation-dashboard .dashboard-tank-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.irrigation-dashboard .dashboard-tank-name {
  font-size: 18px;
  font-weight: 600;
  text-align: center;
  margin-bottom: 12px;
}

.irrigation-dashboard .tank-graphic {
  position: relative;
  width: 90px;
  height: 110px;
  border: 2px solid #94a3b8;
  border-radius: 50% / 14%;
  overflow: hidden;
  background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
  box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.08);
}

.irrigation-dashboard .tank-graphic::before {
  content: '';
  position: absolute;
  inset: -2px -2px auto -2px;
  height: 28px;
  border: 2px solid #94a3b8;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  z-index: 3;
}

.irrigation-dashboard .tank-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(180deg, #60a5fa 0%, #1d4ed8 100%);
  transition: height 0.4s ease;
}

.irrigation-dashboard .tank-fill.tank-empty {
  opacity: 0.35;
  background: linear-gradient(180deg, #93c5fd 0%, #60a5fa 100%);
}

.irrigation-dashboard .tank-fill::before {
  content: '';
  position: absolute;
  left: -5%;
  right: -5%;
  top: -13px;
  height: 26px;
  border-radius: 50%;
  background: rgba(147, 197, 253, 0.9);
}

.irrigation-dashboard .tank-shine {
  position: absolute;
  inset: 10px auto 12px 16px;
  width: 22px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(255,255,255,0.42), rgba(255,255,255,0.04));
  z-index: 4;
}

.irrigation-dashboard .dashboard-tank-stats {
  text-align: center;
}

.irrigation-dashboard .dashboard-tank-percent {
  color: #0f6fe8;
  font-size: 28px;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-tank-litres {
  margin-top: 6px;
  font-size: 16px;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-tank-capacity,
.irrigation-dashboard .dashboard-tank-empty-label,
.irrigation-dashboard .dashboard-tank-updated {
  margin-top: 3px;
  color: var(--muted);
  font-size: 14px;
}

.irrigation-dashboard .dashboard-tank-updated {
  margin-top: 8px;
  font-size: 13px;
}

.irrigation-dashboard .dashboard-tank-updated.stale {
  color: #f59e0b;
}
`;

    let html = '';

    html += '<div class="irrigation-dashboard">';
    html += '<section class="dashboard-section">';
    html += '<div class="dashboard-inner">';

    html += '<div class="dashboard-card-header">';
    html += '<div>';
    html += '<div class="card-title">Water Tanks</div>';
    html += '<div class="list-sub">Current water levels in configured tanks</div>';
    html += '</div>';
    html += '</div>';

    html += '<div class="dashboard-tank-grid">';

    Object.values(this.deviceData?.tanks || []).forEach((tankConfig) => {
      let tank = this.#tanks?.[tankConfig.uuid];

      let percentage = Number.isFinite(Number(tank?.percentage)) === true ? Math.round(Number(tank.percentage)) : 0;
      let fillHeight = percentage === 0 ? 4 : percentage;
      let emptyClass = percentage === 0 ? ' tank-empty' : '';
      let capacity = Number.isFinite(Number(tankConfig?.capacity)) === true ? Number(tankConfig.capacity) : 0;
      let litres = Math.round((capacity * percentage) / 100);
      let name = typeof tankConfig?.name === 'string' && tankConfig.name.trim() !== '' ? tankConfig.name.trim() : 'Water Tank';
      let updated =
        Number.isFinite(Number(tank?.lastUpdated)) === true
          ? new Date(tank.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : undefined;
      let stale = Number.isFinite(Number(tank?.lastUpdated)) === true && Date.now() - Number(tank.lastUpdated) > 300000;

      html += '<section class="card dashboard-tank-card">';
      html += '<div class="dashboard-tank-name">' + escapeHTML(name) + '</div>';
      html += '<div class="dashboard-tank-body">';
      html += '<div class="tank-graphic">';
      html += '<div class="tank-fill' + emptyClass + '" style="height:' + fillHeight + '%"></div>';
      html += '<div class="tank-shine"></div>';
      html += '</div>';
      html += '<div class="dashboard-tank-stats">';
      html += '<div class="dashboard-tank-percent">' + percentage + '%</div>';
      html += '<div class="dashboard-tank-litres">' + litres.toLocaleString() + ' L</div>';
      html += '<div class="dashboard-tank-capacity">/ ' + capacity.toLocaleString() + ' L</div>';

      if (percentage === 0) {
        html += '<div class="dashboard-tank-empty-label">Empty</div>';
      }

      if (updated !== undefined) {
        html += '<div class="dashboard-tank-updated' + (stale === true ? ' stale' : '') + '">Updated: ' + escapeHTML(updated) + '</div>';
      }

      html += '</div>';
      html += '</div>';
      html += '</section>';
    });

    html += '</div>'; // dashboard-tank-grid
    html += '</div>'; // dashboard-inner
    html += '</section>';
    html += '</div>'; // irrigation-dashboard

    return { type: 'html', html, css };
  }
}
