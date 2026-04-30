// IrrigationSystem
// Part of irrigationsystem project
//
// Implements a HomeKit-enabled irrigation controller using HAP-NodeJS.
// Manages irrigation zones, water tanks, flow sensing, leak detection,
// and dashboard rendering for HomeKitUI.
//
// Responsibilities:
// - Create and manage HomeKit IrrigationSystem service and linked Valve services
// - Manage irrigation zones (single or multi-relay valves)
// - Control zone runtime, sequencing, and scheduling via central timer loop
// - Track real-time flow rate and water usage per active zone
// - Aggregate historical water usage and duration per zone
// - Integrate ultrasonic water tank level sensors and expose combined level
// - Detect potential water leaks using rolling flow analysis
// - Maintain HomeKit state synchronisation for system and zones
// - Provide EveHome-compatible data via message bus (GET/SET)
// - Render dashboard UI (Active Zone + Tanks) for HomeKitUI module
//
// Architecture:
// - Extends HomeKitDevice base class (message-driven lifecycle)
// - Uses Valve class for GPIO control and flow sensing
// - Uses WaterTank class for ultrasonic level measurement
// - Uses centralised timers (pauseCheck, zoneCheck) instead of per-zone intervals
// - Uses internal zone registry (#zones) for runtime state tracking
//
// Runtime Model:
// - Only one zone can be active at a time
// - Zone runtime handled via shared 1Hz timer (#processZoneTimer)
// - Multi-relay zones split runtime evenly across valves
// - Flow sensor events drive live flowRate and waterUsed tracking
// - Valve events used for state sync, totals, and leak timing
//
// Leak Detection:
// - Maintains rolling flow buffer (FLOW_DATA_BUFFER)
// - Detects sustained flow when no zones are running
// - Applies grace period after valve close (WATER_LEAK_TIMEOUT)
// - Updates HomeKit LeakSensor and history accordingly
//
// Notes:
// - HomeKit state must be updated from ALL paths (timer, valve events, manual)
//   to avoid desynchronisation ("waiting" state issues)
// - Flow-based tracking is authoritative during timed runs
// - Valve-reported totals only used for manual runs to avoid double counting
//
// Code version 2026/04/30
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
  static VERSION = '2026.04.30';

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

      // Remove any stale valve services that no longer exist in configuration.
      // This handles zones being removed or the zone count being reduced.
      this.accessory.services
        .filter((service) => service.UUID === this.hap.Service.Valve.UUID)
        .forEach((service) => {
          let subtype = Number(service.subtype);

          if (Number.isFinite(subtype) === true && subtype > this.deviceData.zones.length) {
            this.accessory.removeService(service);
          }
        });

      this.#zones = {};

      for (let [index, zone] of this.deviceData.zones.entries()) {
        let service = this.addHKService(this.hap.Service.Valve, 'Valve ' + (index + 1), index + 1);

        // Enable / disable zone
        this.addHKCharacteristic(service, this.hap.Characteristic.IsConfigured, {
          onSet: (value) => this.setZoneEnabled(zone, value),
          onGet: () =>
            zone.enabled === true ? this.hap.Characteristic.IsConfigured.CONFIGURED : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
        });

        // Remaining duration (read-only, controlled by runtime)
        this.addHKCharacteristic(service, this.hap.Characteristic.RemainingDuration, {
          props: { maxValue: this.deviceData.maxRuntime },
        });

        // Set runtime duration
        this.addHKCharacteristic(service, this.hap.Characteristic.SetDuration, {
          onSet: (value) => this.setZoneRuntime(zone, value),
          onGet: () => zone.runtime,
          props: { maxValue: this.deviceData.maxRuntime },
        });

        // Zone name
        this.addHKCharacteristic(service, this.hap.Characteristic.ConfiguredName, {
          onSet: (value) => this.setZoneName(zone, value),
          onGet: () => zone.name,
        });

        // Active state (start/stop zone)
        this.addHKCharacteristic(service, this.hap.Characteristic.Active, {
          onSet: (value) => this.#processActiveCharacteristic(zone, value, 'valve'),
          onGet: () =>
            this.#zones?.[zone.uuid]?.run !== undefined ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
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

          // Unified runtime state
          // When undefined -> zone is idle
          // When object -> zone is actively running (manual or timed)
          run: undefined,

          // Timer control (only used for timed runs)
          endTime: undefined,

          // Multi-valve sequencing support
          activeValveIndex: 0,
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
        if (this.#zones?.[zone?.uuid]?.endTime !== undefined) {
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
        if (this.#zones?.[zone?.uuid]?.run !== undefined) {
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
      if (this.#zones?.[zone?.uuid]?.run !== undefined) {
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

      // Already running -> ignore duplicate start
      if (zoneData.run !== undefined) {
        return;
      }

      // Only one zone is allowed to run at a time, so stop any currently active zone first.
      let runningZone = Object.entries(this.#zones).find(([uuid, data]) => {
        return uuid !== zone.uuid && data.run !== undefined;
      });

      if (runningZone !== undefined) {
        let runningZoneUUID = runningZone[0];

        if (runningZoneUUID !== zone.uuid) {
          let activeZone = this.deviceData.zones.find((z) => z?.uuid === runningZoneUUID);

          if (activeZone !== undefined) {
            this.setZoneActive(activeZone, this.hap.Characteristic.Active.INACTIVE);
          }
        }
      }

      // Reset sequencing state
      zoneData.activeValveIndex = 0;

      let duration = Number(zoneData.service.getCharacteristic(this.hap.Characteristic.SetDuration).value);

      // Set timer FIRST
      zoneData.endTime = Date.now() + duration * 1000;

      // Create run immediately (removes race condition)
      zoneData.run = {
        startTime: Date.now(),
        duration: duration,
        lastValveCloseTime: 0,
        flowRate: 0,
        waterUsed: 0,
        type: 'timed',
      };

      this.history(zoneData.service, {
        time: Math.floor(zoneData.run.startTime / 1000),
        status: 1,
        water: 0,
        duration: 0,
      });

      this?.log?.info?.('Zone "%s" was turned "on"', zone.name);

      // Update HomeKit BEFORE opening valves
      zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, duration);

      // Open first valve only (force clean state)
      if (Array.isArray(zoneData.valves) === true && zoneData.valves.length > 0) {
        zoneData.valves.forEach((valve, index) => {
          if (index === 0) {
            valve.open();
          } else if (valve.isOpen() === true) {
            valve.close();
          }
        });
      }

      return;
    }

    if (this.deviceData.power === false && (value === this.hap.Characteristic.Active.ACTIVE || value === true)) {
      // Request to turn on sprinkler while irrigation system is powered off.
      setTimeout(() => {
        zoneData.run = undefined;
        zoneData.endTime = undefined;
        zoneData.activeValveIndex = 0;

        zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
      }, 500);

      return;
    }

    if (value === this.hap.Characteristic.Active.INACTIVE || value === false) {
      // Request to turn off sprinkler.
      zoneData.endTime = undefined;
      zoneData.activeValveIndex = 0;

      zoneData.valves.forEach((valve) => {
        if (valve.isOpen() === true) {
          valve.close();
        }
      });

      // Safety fallback
      setTimeout(() => {
        if (zoneData.run !== undefined) {
          let anyOpen = zoneData.valves.some((v) => v.isOpen() === true);

          if (anyOpen === false) {
            // force cleanup
            zoneData.run = undefined;

            zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
            zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
            zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
          }
        }
      }, 2000);
    }
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
            this.setPower(activeCheck.value);
          } else if ((activeCheck.type === 'system' || activeCheck.type === 'switch') && activeCheck.takeaction === false) {
            // Empty. HomeKit has already been updated, but no action is required.
          }

          if (activeCheck.type === 'valve' && activeCheck.takeaction === true) {
            this.setZoneActive(activeCheck.context, activeCheck.value);
          } else if (activeCheck.type === 'valve' && activeCheck.takeaction === false) {
            // Workaround for active state of valves going to "waiting" when we don't want them to straight after the callback to HomeKit
            setTimeout(() => {
              let zoneData = this.#zones?.[activeCheck.context?.uuid];

              if (zoneData?.service !== undefined) {
                zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
                zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
                zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
              }
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

    // Must have an active run AND a valid endTime (timed run only).
    if (typeof zoneData !== 'object' || zoneData.run === undefined || Number.isFinite(Number(zoneData.endTime)) !== true) {
      return;
    }

    let now = Date.now();
    let runtime =
      Number.isFinite(Number(zoneData.run?.duration)) === true
        ? Number(zoneData.run.duration)
        : Number(zoneData.service.getCharacteristic(this.hap.Characteristic.SetDuration).value);
    let valveCount = Array.isArray(zoneData.valves) === true ? zoneData.valves.length : 0;

    if (now < zoneData.endTime) {
      zoneData.service.updateCharacteristic(
        this.hap.Characteristic.RemainingDuration,
        Math.max(0, Math.floor((zoneData.endTime - now) / 1000)),
      );

      if (valveCount > 1 && runtime > 0) {
        if (Number.isFinite(Number(zoneData.activeValveIndex)) !== true) {
          zoneData.activeValveIndex = 0;
        }

        let runtimeMS = runtime * 1000;
        let elapsed = now - zoneData.run.startTime;

        if (elapsed < 0) {
          elapsed = 0;
        }
        if (elapsed > runtimeMS) {
          elapsed = runtimeMS;
        }

        let slice = runtimeMS / valveCount;

        if (slice <= 0) {
          return;
        }

        let valveIndex = Math.min(valveCount - 1, Math.floor(elapsed / slice));

        if (valveIndex !== zoneData.activeValveIndex) {
          let previousIndex = zoneData.activeValveIndex;

          zoneData.activeValveIndex = valveIndex;

          // Close previous valve FIRST. Only one valve can ever be open.
          if (zoneData.valves[previousIndex]?.isOpen() === true) {
            zoneData.valves[previousIndex].close();
          }

          // Then open target valve.
          if (zoneData.valves[valveIndex]?.isOpen() === false) {
            zoneData.valves[valveIndex].open();
          }
        }

        // Hard safety sync.
        zoneData.valves.forEach((valve, index) => {
          if (index !== zoneData.activeValveIndex && valve.isOpen() === true) {
            valve.close();
          }
        });

        if (zoneData.valves[zoneData.activeValveIndex]?.isOpen() === false) {
          zoneData.valves[zoneData.activeValveIndex].open();
        }
      }

      return;
    }

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
    let now = Date.now();
    let eventTime = Number(message.time);

    this.flowData.push({
      ...message,
      time: eventTime,
    });

    // Keep only the configured rolling flow window (milliseconds)
    while (
      this.flowData.length > 0 &&
      Number.isFinite(Number(this.flowData[0]?.time)) === true &&
      eventTime - Number(this.flowData[0].time) > FLOW_DATA_BUFFER
    ) {
      this.flowData.shift();
    }

    // Track live flow against ACTIVE runs (single source of truth)
    Object.values(this.#zones || {}).forEach((zone) => {
      if (zone?.run !== undefined) {
        zone.run.flowRate = Number.isFinite(Number(message?.rate)) === true ? Number(message.rate) : 0;

        if (Number.isFinite(Number(message?.volume)) === true) {
          zone.run.waterUsed = zone.run.waterUsed + Number(message.volume);
        }
      }
    });

    if (this.leakSensorService !== undefined) {
      let noZonesRunning = Object.values(this.#zones || {}).every((zone) => zone?.run === undefined);

      // Pressure-decay aware grace handling
      let decayWindow = this.flowData.filter((flow) => {
        return this.lastValveClose === 0 || Number(flow.time) > this.lastValveClose;
      });

      let recentSamples = decayWindow.slice(-3);

      let flowSettled =
        recentSamples.length >= 3 &&
        recentSamples.every((flow) => {
          return Number.isFinite(Number(flow?.rate)) !== true || Number(flow.rate) < 0.05;
        });

      let leakGraceExpired = this.lastValveClose === 0 || (now - this.lastValveClose > WATER_LEAK_TIMEOUT && flowSettled === true);

      let leakFlowData = this.flowData.filter((flow) => {
        return this.lastValveClose === 0 || Number(flow.time) > this.lastValveClose + WATER_LEAK_TIMEOUT;
      });

      let leakSamples = leakFlowData.filter((flow) => {
        return Number.isFinite(Number(flow?.volume)) === true && Number(flow.volume) > 0;
      }).length;

      let leakVolume = leakFlowData.reduce((total, flow) => {
        return total + (Number.isFinite(Number(flow?.volume)) === true ? Number(flow.volume) : 0);
      }, 0);

      let averageFlowRate =
        leakFlowData.length !== 0
          ? leakFlowData.reduce((total, flow) => {
            return total + (Number.isFinite(Number(flow?.rate)) === true ? Number(flow.rate) : 0);
          }, 0) / leakFlowData.length
          : 0;

      let leakPercentage = leakFlowData.length !== 0 ? (leakSamples / leakFlowData.length) * 100 : 0;

      if (
        noZonesRunning === true &&
        leakGraceExpired === true &&
        leakFlowData.length > 3 &&
        leakPercentage > 60 &&
        leakVolume > 0 &&
        averageFlowRate > 0.2
      ) {
        if (this.leakDetected === false) {
          this.leakDetected = true;

          this.history(this.leakSensorService, { time: Math.floor(now / 1000), status: 1 });

          if (this.deviceData.waterLeakAlert === true) {
            this.leakSensorService.updateCharacteristic(
              this.hap.Characteristic.LeakDetected,
              this.hap.Characteristic.LeakDetected.LEAK_DETECTED,
            );
          }

          this?.log?.warn?.('Detected suspected water leak on irrigation system');
        }
      }

      if (noZonesRunning === true && leakFlowData.length > 3 && leakVolume === 0 && this.leakDetected === true) {
        this.leakDetected = false;

        this.history(this.leakSensorService, { time: Math.floor(now / 1000), status: 0 });

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

    this.deviceData.zones.forEach((zone) => {
      if (this.#zones?.[zone.uuid]?.valves?.some((valve) => valve?.uuid === message.uuid) === true) {
        associatedZone = zone;
      }
    });

    if (this.#zones?.[associatedZone?.uuid] === undefined) {
      return;
    }

    let zoneData = this.#zones[associatedZone.uuid];

    if (message.status === Valve.OPENED) {
      // First valve opening starts the run.
      // Timed runs are normally created by setZoneActive() before the valve is opened.
      // If no run exists here, treat it as a manual/physical valve activation fallback.
      if (zoneData.run === undefined) {
        // Determine run type ONLY based on whether a timer exists
        let isTimed = Number.isFinite(Number(zoneData.endTime)) === true;

        zoneData.run = {
          startTime: message.time,
          lastValveCloseTime: 0,
          flowRate: 0,
          waterUsed: 0,
          type: isTimed === true ? 'timed' : 'manual',
        };

        this.history(zoneData.service, {
          time: Math.floor(message.time / 1000),
          status: 1,
          water: 0,
          duration: 0,
        });

        this?.log?.info?.('Zone "%s" was turned "on"', associatedZone.name);
      }

      zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.IN_USE);
    }

    if (message.status === Valve.CLOSED) {
      if (zoneData.run === undefined) {
        return;
      }

      zoneData.run.lastValveCloseTime = message.time;
      this.lastValveClose = message.time;

      // If another valve is still open, this is only a relay change.
      let anotherValveOpen = zoneData.valves.some((valve) => {
        return valve?.uuid !== message.uuid && valve.isOpen() === true;
      });

      if (anotherValveOpen === true) {
        return;
      }

      // TIMED RUN -> timer owns lifecycle while endTime is still in the future.
      if (zoneData.run.type === 'timed' && Number.isFinite(Number(zoneData.endTime)) === true && Date.now() < zoneData.endTime) {
        return;
      }

      let totalDuration = Math.max(0, Number(message.time) - Number(zoneData.run.startTime)) / 1000;
      let totalWater = zoneData.run.waterUsed;

      this.history(zoneData.service, {
        time: Math.floor(message.time / 1000),
        status: 0,
        water: totalWater,
        duration: totalDuration,
      });

      this?.log?.info?.('Zone "%s" was turned "off"', associatedZone.name);

      zoneData.run = undefined;
      zoneData.endTime = undefined;
      zoneData.activeValveIndex = 0;

      zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
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

    let formatDuration = (seconds) => {
      let duration = Number.isFinite(Number(seconds)) === true ? Math.max(0, Math.floor(Number(seconds))) : 0;
      let minutes = Math.floor(duration / 60);
      let remainingSeconds = duration % 60;

      return String(minutes).padStart(2, '0') + ':' + String(remainingSeconds).padStart(2, '0');
    };

    // Find active zone and live runtime values.
    let activeZone = undefined;

    Object.values(this.deviceData?.zones || []).forEach((zone) => {
      if (activeZone === undefined && this.#zones?.[zone?.uuid]?.run !== undefined) {
        activeZone = zone;
      }
    });

    let activeZoneData = this.#zones?.[activeZone?.uuid];
    let activeRuntime =
      activeZoneData !== undefined ? Number(activeZoneData.service.getCharacteristic(this.hap.Characteristic.SetDuration).value) : 0;
    let remaining =
      activeZoneData !== undefined && Number.isFinite(Number(activeZoneData.endTime)) === true
        ? Math.max(0, Math.floor((Number(activeZoneData.endTime) - Date.now()) / 1000))
        : 0;
    let complete =
      activeZoneData !== undefined &&
      Number.isFinite(Number(activeZoneData.endTime)) === true &&
      activeRuntime > 0 &&
      remaining <= activeRuntime
        ? Math.max(0, Math.min(100, Math.round(((activeRuntime - remaining) / activeRuntime) * 100)))
        : 0;
    let flowRate =
      activeZoneData !== undefined &&
      typeof activeZoneData.run === 'object' &&
      Number.isFinite(Number(activeZoneData.run.flowRate)) === true
        ? Number(activeZoneData.run.flowRate)
        : 0;

    let waterUsed =
      activeZoneData !== undefined &&
      typeof activeZoneData.run === 'object' &&
      Number.isFinite(Number(activeZoneData.run.waterUsed)) === true
        ? Number(activeZoneData.run.waterUsed)
        : 0;

    // Leak card only renders when the leak sensor is configured.
    let leakConfigured = this.leakSensorService !== undefined;
    let leakStatus = this.leakDetected === true ? 'alert' : 'ok';

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

.irrigation-dashboard .dashboard-active-card,
.irrigation-dashboard .dashboard-leak-card {
  width: 100%;
  max-width: 760px;
}

.irrigation-dashboard .dashboard-active-card {
  padding: 18px 22px;
  margin-bottom: 34px;
  border: 1px solid rgba(49, 182, 75, 0.22);
  background: rgba(49, 182, 75, 0.035);
}

.irrigation-dashboard .dashboard-active-card.running {
  border-color: rgba(15, 111, 232, 0.25);
  background: rgba(15, 111, 232, 0.035);
}

.irrigation-dashboard .dashboard-active-content {
  display: grid;
  grid-template-columns: 64px minmax(280px, 1fr) 96px 130px;
  gap: 18px;
  align-items: center;
}

.irrigation-dashboard .dashboard-active-icon {
  width: 52px;
  height: 52px;
  border: 3px solid #2f7d43;
  border-radius: 50%;
  color: #2f7d43;
  display: flex;
  align-items: center;
  justify-content: center;
}

.irrigation-dashboard .dashboard-active-card.running .dashboard-active-icon {
  border-color: #0f6fe8;
  color: #0f6fe8;
}

.irrigation-dashboard .dashboard-active-icon svg,
.irrigation-dashboard .dashboard-active-stat svg,
.irrigation-dashboard .dashboard-leak-icon svg {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.irrigation-dashboard .dashboard-active-icon svg {
  width: 28px;
  height: 28px;
  stroke-width: 2.4;
}

.irrigation-dashboard .dashboard-active-details {
  display: flex;
  flex-direction: column;
}

.irrigation-dashboard .dashboard-active-title {
  color: #2f7d43;
  font-size: 18px;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-active-card.running .dashboard-active-title {
  color: #0f6fe8;
}

.irrigation-dashboard .dashboard-active-sub {
  margin-top: 5px;
  color: var(--muted);
  font-size: 14px;
}

.irrigation-dashboard .dashboard-active-stats {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.irrigation-dashboard .dashboard-active-stat {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 14px;
}

.irrigation-dashboard .dashboard-active-stat svg {
  width: 18px;
  height: 18px;
  color: #0f6fe8;
  stroke-width: 2.2;
}

.irrigation-dashboard .dashboard-active-stat-label {
  color: var(--muted);
}

.irrigation-dashboard .dashboard-active-stat-value {
  color: var(--text);
  font-weight: 700;
}

.irrigation-dashboard .dashboard-active-time {
  min-width: 120px;
  padding-left: 20px;
  border-left: 1px solid rgba(0, 0, 0, 0.08);
}

.irrigation-dashboard .dashboard-active-time-label {
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}

.irrigation-dashboard .dashboard-active-time-value {
  margin-top: 4px;
  color: #0f6fe8;
  font-size: 24px;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-active-time-total {
  margin-top: 2px;
  color: var(--muted);
  font-size: 14px;
}

.irrigation-dashboard .dashboard-progress {
  width: 86px;
  height: 86px;
  border-radius: 50%;
  background:
    radial-gradient(circle closest-side, #ffffff 72%, transparent 73%),
    conic-gradient(#0f6fe8 var(--progress), #e5e7eb 0);
  display: flex;
  align-items: center;
  justify-content: center;
}

.irrigation-dashboard .dashboard-progress-inner {
  text-align: center;
}

.irrigation-dashboard .dashboard-progress-percent {
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.irrigation-dashboard .dashboard-progress-label {
  margin-top: 4px;
  color: var(--muted);
  font-size: 10px;
  line-height: 1;
}

.irrigation-dashboard .dashboard-leak-card {
  padding: 16px 22px;
  margin-bottom: 34px;
}

.irrigation-dashboard .dashboard-leak-card.ok {
  border: 1px solid rgba(49, 182, 75, 0.22);
  background: rgba(49, 182, 75, 0.035);
}

.irrigation-dashboard .dashboard-leak-card.alert {
  border: 1px solid rgba(217, 68, 68, 0.35);
  background: rgba(217, 68, 68, 0.06);
}

.irrigation-dashboard .dashboard-leak-content {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  gap: 16px;
  align-items: center;
}

.irrigation-dashboard .dashboard-leak-icon {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #2f7d43;
  border: 2px solid #2f7d43;
  display: flex;
  align-items: center;
  justify-content: center;
}

.irrigation-dashboard .dashboard-leak-card.alert .dashboard-leak-icon {
  color: #d94444;
  border-color: #d94444;
}

.irrigation-dashboard .dashboard-leak-icon svg {
  width: 22px;
  height: 22px;
  stroke-width: 2.4;
}

.irrigation-dashboard .dashboard-leak-title {
  color: #2f7d43;
  font-size: 16px;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-leak-card.alert .dashboard-leak-title {
  color: #d94444;
}

.irrigation-dashboard .dashboard-leak-sub {
  margin-top: 4px;
  color: var(--muted);
  font-size: 14px;
}

.irrigation-dashboard .dashboard-leak-toggle {
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--muted);
  padding: 4px;
}

.irrigation-dashboard .dashboard-leak-toggle svg {
  width: 20px;
  height: 20px;
  stroke: currentColor;
  stroke-width: 2.5;
  fill: none;
  transition: transform 0.25s ease, color 0.2s ease;
}

.irrigation-dashboard .dashboard-leak-toggle:hover {
  color: var(--accent);
}

.irrigation-dashboard .dashboard-leak-toggle.open svg {
  transform: rotate(180deg);
}

.irrigation-dashboard .dashboard-collapse {
  max-height: 0;
  overflow: hidden;
  opacity: 0;
  transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.2s ease;
}

.irrigation-dashboard .dashboard-collapse.open {
  max-height: 600px;
  opacity: 1;
  margin-top: 16px;
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

@media (max-width: 800px) {
  .irrigation-dashboard .dashboard-active-content {
    grid-template-columns: 52px 1fr;
  }

  .irrigation-dashboard .dashboard-active-time {
    grid-column: 1 / -1;
    padding-left: 0;
    border-left: 0;
  }

  .irrigation-dashboard .dashboard-progress {
    grid-column: 1 / -1;
  }

  .irrigation-dashboard .dashboard-leak-content {
    grid-template-columns: 44px 1fr;
  }

  .irrigation-dashboard .dashboard-leak-link {
    grid-column: 1 / -1;
    text-align: left;
    padding-left: 0;
  }
}
`;

    let html = '';

    html += '<div class="irrigation-dashboard">';
    html += '<section class="dashboard-section">';
    html += '<div class="dashboard-inner">';

    // Render leak detection card when leak monitoring is configured.
    if (leakConfigured === true) {
      html += '<div class="dashboard-card-header">';
      html += '<div>';
      html += '<div class="card-title">Leak Detection</div>';
      html += '<div class="list-sub">Unexpected water flow monitoring</div>';
      html += '</div>';
      html += '</div>';

      html += '<section class="card dashboard-leak-card ' + leakStatus + '">';
      html += '<div class="dashboard-leak-content">';

      html += '<div class="dashboard-leak-icon">';
      if (this.leakDetected === true) {
        html +=
          '<svg viewBox="0 0 24 24"><path d="M12 3C12 3 6 10 6 14a6 6 0 0 0 12 0c0-4-6-11-6-11z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>';
      } else {
        html += '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
      }
      html += '</div>';

      html += '<div>';
      html += '<div class="dashboard-leak-title">' + (this.leakDetected === true ? 'Water Leak Detected' : 'No Leak Detected') + '</div>';
      html += '<div class="dashboard-leak-sub">';
      html +=
        this.leakDetected === true
          ? 'Unexpected flow detected while no zones are active'
          : 'No unexpected flow detected while system is idle';
      html += '</div>';
      html += '</div>';

      html += '<button class="dashboard-leak-toggle" data-collapse="leak-details" onclick="toggleCollapse(\'leak-details\', this)">';
      html += '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
      html += '</button>';
      html += '</div>';

      html += '<div id="leak-details" class="dashboard-collapse">';
      html += '<div class="list">';
      html += '<div class="list-row">';
      html += '<div>';
      html += '<div class="list-title">Flow Buffer</div>';
      html += '<div class="list-sub">' + this.flowData.length + ' recent readings used for leak detection</div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="list-row">';
      html += '<div>';
      html += '<div class="list-title">Detection State</div>';
      html += '<div class="list-sub">' + (this.leakDetected === true ? 'Leak currently detected' : 'No leak currently detected') + '</div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';

      html += '</section>';
    }

    // Render active irrigation zone status.
    html += '<div class="dashboard-card-header">';
    html += '<div>';
    html += '<div class="card-title">Active Zone</div>';
    html += '<div class="list-sub">Current irrigation zone status</div>';
    html += '</div>';
    html += '</div>';

    html += '<section class="card dashboard-active-card' + (activeZone !== undefined ? ' running' : '') + '">';
    html += '<div class="dashboard-active-content">';

    html += '<div class="dashboard-active-icon">';
    if (activeZone !== undefined) {
      html +=
        '<svg viewBox="0 0 24 24"><path d="M12 14v7"/><path d="M8 21h8"/><path d="M9 14h6"/><path d="M12 4v3"/><path d="M6 7l2 2"/><path d="M18 7l-2 2"/><path d="M4 12h3"/><path d="M20 12h-3"/></svg>';
    } else {
      html += '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
    }
    html += '</div>';

    html += '<div class="dashboard-active-details">';
    html += '<div class="dashboard-active-title">' + (activeZone !== undefined ? escapeHTML(activeZone.name) : 'No Active Zone') + '</div>';
    html += '<div class="dashboard-active-sub">' + (activeZone !== undefined ? 'Irrigating' : 'All zones are currently off') + '</div>';

    if (activeZone !== undefined) {
      html += '<div class="dashboard-active-stats">';

      html += '<div class="dashboard-active-stat">';
      html += '<svg viewBox="0 0 24 24"><path d="M12 3C12 3 6 10 6 14a6 6 0 0 0 12 0c0-4-6-11-6-11z"/></svg>';
      html += '<div>';
      html += '<div class="dashboard-active-stat-label">Flow Rate</div>';
      html += '<div class="dashboard-active-stat-value">' + flowRate.toFixed(1) + ' L/min</div>';
      html += '</div>';
      html += '</div>';

      html += '<div class="dashboard-active-stat">';
      html += '<svg viewBox="0 0 24 24"><path d="M6 4h12"/><path d="M7 4l1 17h8l1-17"/><path d="M9 9h6"/></svg>';
      html += '<div>';
      html += '<div class="dashboard-active-stat-label">Water Used</div>';
      html += '<div class="dashboard-active-stat-value">' + Math.round(waterUsed).toLocaleString() + ' L</div>';
      html += '</div>';
      html += '</div>';

      html += '</div>';
    }

    html += '</div>';

    if (activeZone !== undefined) {
      html += '<div class="dashboard-progress" style="--progress: ' + complete + '%">';
      html += '<div class="dashboard-progress-inner">';
      html += '<div class="dashboard-progress-percent">' + complete + '%</div>';
      html += '<div class="dashboard-progress-label">Complete</div>';
      html += '</div>';
      html += '</div>';

      html += '<div class="dashboard-active-time">';
      html += '<div class="dashboard-active-time-label">Time Remaining</div>';
      html += '<div class="dashboard-active-time-value">' + formatDuration(remaining) + '</div>';
      html += '<div class="dashboard-active-time-total">of ' + formatDuration(activeRuntime) + '</div>';
      html += '</div>';
    }

    html += '</div>';
    html += '</section>';

    // Render configured water tank cards.
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

    html += '</div>';
    html += '</div>';
    html += '</section>';
    html += '</div>';

    return { type: 'html', html, css };
  }
}
