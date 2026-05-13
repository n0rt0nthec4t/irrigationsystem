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
import FlowSensor from './flowsensor.js';
import { crc32 } from './utils.js';

// Define constants
const WATER_LEAK_TIMEOUT = 10000; // Milliseconds after a water valve is closed before we can report on any water leak

// Setup GPIO library for our device classes that require it
// This allows the classes to use GPIO functions without needing to import or initialise the library themselves.
// The library is initialised once in the main system class and then assigned to the static GPIO property of each class that needs it.
Valve.GPIO = GPIO;
FlowSensor.GPIO = GPIO;
WaterTank.GPIO = GPIO;

export default class IrrigationSystem extends HomeKitDevice {
  static TYPE = 'IrrigationSystem';
  static VERSION = '2026.05.13';

  irrigationService = undefined; // HomeKit service for this irrigation system
  leakSensorService = undefined; // HomeKit service for a "leak" sensor
  switchService = undefined;
  lastValveClose = 0; // Last time a valve was closed
  activeCheck = [];
  activeCheckTimer = undefined;
  leakDetected = false; // No Water leak detected yet

  // Internal data only for this class
  #tanks = {}; // Object for tanks we actually created
  #zones = {}; // Object for zones we actually created
  #flowSensor = undefined; // Flow sensor instance
  #lastFlowRate = 0; // Last water flow rate
  #lastFlowTime = 0; // Last time water flowed
  #unassignedWaterUsed = 0; // Track water

  constructor(accessory, api, deviceData) {
    super(accessory, api, deviceData);

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
    this.irrigationService = this.addService(this.hap.Service.IrrigationSystem, '', 1, {
      messages: this.message.bind(this),
    });
    this.irrigationService.setPrimaryService();

    // Sync initial power state to HomeKit
    this.irrigationService.updateCharacteristic(
      this.hap.Characteristic.Active,
      this.deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );

    // Active characteristic (system on/off)
    this.addCharacteristic(this.irrigationService, this.hap.Characteristic.Active, {
      onSet: (value) => {
        this.#processActiveCharacteristic(this.irrigationService, value, 'system');
      },
      onGet: () => {
        return this.deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    // Optional virtual power switch (linked service)
    if (this.deviceData?.powerSwitch === true) {
      this.#setupPowerSwitch(this.deviceData, true);
    }

    // Create water tanks (if configured)
    this.#setupWaterTanks(this.deviceData, true);
    Object.values(this.#tanks).forEach((tank) => {
      this.postSetupDetail('Watertank "%s" with "%s" Litres', tank.config.name, tank.config.capacity);
    });

    // Create irrigation zones
    this.#setupZones(this.deviceData, true);
    Object.values(this.#zones).forEach((zone) => {
      this.postSetupDetail('Zone "%s"', zone.config.name, zone.config.enabled === false ? '(disabled)' : '');
    });

    // Create flow sensor if configured.
    // FlowSensor owns GPIO polling, flow calculation, and leak detection.
    // IrrigationSystem only consumes FLOW_EVENT and LEAK_EVENT messages.
    if (this.deviceData?.sensorFlowPin !== undefined) {
      this.#setupFlowSensor(this.deviceData, true);
    }

    // Setup optional HomeKit leak sensor
    if (this.#flowSensor !== undefined && this.deviceData?.leakSensor === true) {
      this.#setupLeakSensor(this.deviceData, true);
    }

    // Register timers
    this.addTimer('pauseCheck', { interval: 5000 }); // Resume watering after pause
    this.addTimer('zoneCheck', { interval: 1000 }); // Centralised zone runtime handler

    // Setup summary logging
    this.switchService !== undefined && this.postSetupDetail('Virtual power switch');
    this.#flowSensor !== undefined && this.postSetupDetail('Water flow sensor');
    this.leakSensorService !== undefined &&
      this.postSetupDetail('Leak sensor', this.deviceData?.waterLeakAlert === true ? 'with alerting' : 'with no alerting');
  }

  onUpdate(deviceData = {}) {
    if (typeof deviceData !== 'object' || deviceData === null) {
      return;
    }

    this.#setupPowerSwitch(deviceData);
    this.#setupWaterTanks(deviceData);
    this.#setupZones(deviceData);
    this.#setupFlowSensor(deviceData);
    this.#setupLeakSensor(deviceData);

    // Updated changes to HomeKit water leak alerting
    if (this.#flowSensor !== undefined && Object.hasOwn(deviceData, 'waterLeakAlert') === true) {
      let waterLeakAlert = deviceData.waterLeakAlert === true;

      if (this.leakSensorService !== undefined && waterLeakAlert !== this.deviceData.waterLeakAlert) {
        this?.log?.info?.('Leak sensor', waterLeakAlert === true ? 'with alerting' : 'with no alerting');
      }
    }
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
    if (typeof type !== 'string' || type === '') {
      return;
    }

    if (type === WaterTank.WATERLEVEL_EVENT) {
      this.#handleWaterLevelEvent(message);
    }

    if (type === FlowSensor.FLOW_EVENT) {
      this.#handleFlowEvent(message);
    }

    if (type === FlowSensor.LEAK_EVENT) {
      this.#handleLeakEvent(message);
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

    // Nothing changed
    if (name === zone.name) {
      return;
    }

    this?.log?.debug?.('Setting irrigation zone name from "%s" to "%s"', zone.name, name);

    // Persist internal name
    zone.name = name;

    // Keep stored zone config in sync
    if (this.#zones?.[zone.uuid]?.config !== undefined) {
      this.#zones[zone.uuid].config.name = name;
    }

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
      typeof this.#zones?.[zone?.uuid] !== 'object'
    ) {
      return;
    }

    let zoneData = this.#zones[zone.uuid];
    let currentZone = this.deviceData?.zones?.find((item) => item?.uuid === zone.uuid);
    let activeZone = currentZone ?? zoneData.config ?? zone;
    let wantsStart = value === this.hap.Characteristic.Active.ACTIVE || value === true;
    let wantsStop = value === this.hap.Characteristic.Active.INACTIVE || value === false;
    let zoneEnabled = activeZone?.enabled === true;

    if (wantsStart === true && zoneEnabled !== true) {
      this?.log?.warn?.('Ignored request to start disabled zone "%s"', activeZone.name);

      zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);

      return;
    }

    if (this.deviceData.power === true && wantsStart === true) {
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

      // Flow is now expected, so suppress leak detection while watering.
      this.#flowSensor?.markExpectedFlow?.(true);

      this.history(zoneData.service, {
        time: Math.floor(zoneData.run.startTime / 1000),
        status: 1,
        water: 0,
        duration: 0,
      });

      this?.log?.info?.('Zone "%s" was turned "on"', activeZone.name);

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

    if (this.deviceData.power === false && wantsStart === true) {
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

    if (wantsStop === true) {
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
        if (zoneData.run === undefined) {
          return;
        }

        let anyOpen = zoneData.valves.some((v) => v.isOpen() === true);

        if (anyOpen === true) {
          this?.log?.warn?.('Zone "%s" did not report all valves closed after stop request; forcing HomeKit state idle', activeZone.name);
        }

        // If the valve close event did not complete cleanup, end the logical run
        // so continued flow is treated as unexpected/leak flow instead of watering.
        zoneData.run = undefined;
        zoneData.endTime = undefined;
        zoneData.activeValveIndex = 0;

        this.#flowSensor?.markExpectedFlow?.(false);

        zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
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
    this.history(this.irrigationService, { time: Math.floor(Date.now() / 1000), level: totalPercentage }, { timegap: 600 });
  }

  #handleFlowEvent(message = {}) {
    if (typeof message !== 'object' || message === null || Number.isFinite(Number(message?.time)) !== true) {
      return;
    }

    // Store latest system-wide flow so the dashboard can show flow even when
    // no zone is active, such as during leak detection/manual valve opening.
    let flowRate = Number.isFinite(Number(message?.rate)) === true ? Number(message.rate) : 0;
    let flowVolume = Number.isFinite(Number(message?.volume)) === true ? Number(message.volume) : 0;
    let activeRun = false;
    let isLeakGracePeriod =
      Number.isFinite(Number(this.lastValveClose)) === true &&
      this.lastValveClose > 0 &&
      Date.now() - Number(this.lastValveClose) <= WATER_LEAK_TIMEOUT;

    this.#lastFlowRate = flowRate;
    this.#lastFlowTime = Number(message.time);

    // Track live flow against ACTIVE runs.
    Object.values(this.#zones || {}).forEach((zone) => {
      if (zone?.run !== undefined) {
        activeRun = true;
        zone.run.flowRate = flowRate;
        zone.run.waterUsed = zone.run.waterUsed + flowVolume;
      }
    });

    // Track flow that is not assigned to a zone.
    // This covers leak/manual valve flow while no zone is running.
    // Do not count residual flow immediately after a normal zone closes.
    if (activeRun === false && isLeakGracePeriod === false && flowRate > 0 && flowVolume > 0) {
      this.#unassignedWaterUsed = this.#unassignedWaterUsed + flowVolume;
    }

    // Reset stale unassigned usage after flow has stopped.
    if (activeRun === false && flowRate === 0) {
      this.#unassignedWaterUsed = 0;
    }
  }

  #handleLeakEvent(message = {}) {
    if (
      typeof message !== 'object' ||
      message === null ||
      Number.isFinite(Number(message?.time)) !== true ||
      (message.status !== 0 && message.status !== 1)
    ) {
      return;
    }

    if (this.leakSensorService === undefined) {
      return;
    }

    if (message.status === 1 && this.leakDetected === false) {
      this.leakDetected = true;

      this.history(this.leakSensorService, { time: Math.floor(Number(message.time) / 1000), status: 1 });

      if (this.deviceData.waterLeakAlert === true) {
        this.leakSensorService.updateCharacteristic(
          this.hap.Characteristic.LeakDetected,
          this.hap.Characteristic.LeakDetected.LEAK_DETECTED,
        );
      }

      this?.log?.warn?.('Detected suspected water leak on irrigation system');
    }

    if (message.status === 0 && this.leakDetected === true) {
      this.leakDetected = false;

      this.history(this.leakSensorService, { time: Math.floor(Number(message.time) / 1000), status: 0 });

      this.leakSensorService.updateCharacteristic(
        this.hap.Characteristic.LeakDetected,
        this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );

      this?.log?.success?.('Suspected water leak no longer detected on irrigation system');
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
      if (zoneData.run === undefined && associatedZone?.enabled !== true) {
        let openedValve = zoneData.valves.find((valve) => valve?.uuid === message.uuid);

        this?.log?.warn?.('Closing disabled zone "%s" after unexpected valve open event', associatedZone.name);
        openedValve?.close?.();

        zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);

        return;
      }

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

      // Format duration (mm:ss)
      let minutes = Math.floor(totalDuration / 60);
      let seconds = Math.floor(totalDuration % 60);
      let durationText = minutes + 'm ' + seconds + 's';

      // Format water (litres)
      let waterText =
        Number.isFinite(Number(totalWater)) === true && totalWater > 0 ? Math.round(totalWater).toLocaleString() + 'L' : undefined;

      this.history(zoneData.service, {
        time: Math.floor(message.time / 1000),
        status: 0,
        water: totalWater,
        duration: totalDuration,
      });

      // Enhanced logging
      this?.log?.info?.(
        waterText !== undefined ? 'Zone "%s" was turned "off" after %s using %s' : 'Zone "%s" was turned "off" after %s',
        associatedZone.name,
        durationText,
        ...(waterText !== undefined ? [waterText] : []),
      );

      // Flow is no longer expected, so start leak detection grace window.
      this.#flowSensor?.markExpectedFlow?.(false);

      zoneData.run = undefined;
      zoneData.endTime = undefined;
      zoneData.activeValveIndex = 0;

      zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
    }
  }

  #setupPowerSwitch(deviceData = {}, atStart = false) {
    if (deviceData?.powerSwitch === true) {
      if (this.switchService === undefined) {
        this.switchService = this.addService(this.hap.Service.Switch, '', 1);

        // HomeKit service name.
        this.addCharacteristic(this.switchService, this.hap.Characteristic.Name);
        this.switchService.updateCharacteristic(this.hap.Characteristic.Name, '');

        this.addCharacteristic(this.switchService, this.hap.Characteristic.On, {
          onSet: (value) => {
            if (value !== this.deviceData.power) {
              this.setPower(value);
            }
          },
          onGet: () => {
            return this.deviceData.power === true;
          },
        });

        if (atStart === false) {
          this?.log?.info?.('Virtual power switch has been added');
        }
      }

      // Always keep state in sync.
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, this.deviceData.power === true);

      return;
    }

    // Remove if no longer configured.
    if (this.switchService !== undefined) {
      this.removeService(this.switchService);
      this.switchService = undefined;

      if (atStart === false) {
        this?.log?.info?.('Virtual power switch has been removed');
      }
    }
  }

  #setupWaterTanks(deviceData = {}) {
    if (Array.isArray(deviceData?.tanks) !== true) {
      deviceData.tanks = [];
    }

    let activeTanks = deviceData.tanks.filter((tank) => {
      return (
        typeof tank === 'object' &&
        tank !== null &&
        tank.enabled === true &&
        tank.sensorEchoPin !== undefined &&
        tank.sensorTrigPin !== undefined &&
        typeof tank.uuid === 'string' &&
        tank.uuid !== ''
      );
    });

    let activeUUIDs = activeTanks.map((tank) => tank.uuid);

    // Remove tanks no longer configured, disabled, or no longer valid
    Object.keys(this.#tanks || {}).forEach((uuid) => {
      if (activeUUIDs.includes(uuid) === false) {
        this.#tanks[uuid]?.instance?.onShutdown?.();

        this?.log?.debug?.('Watertank "%s" has been removed', this.#tanks[uuid]?.config?.name ?? uuid);

        delete this.#tanks[uuid];
      }
    });

    // Add / update active tanks
    activeTanks.forEach((tank) => {
      this.addCharacteristic(this.irrigationService, this.hap.Characteristic.WaterLevel);

      if (this.#tanks?.[tank.uuid] === undefined) {
        this.#tanks[tank.uuid] = {
          instance: new WaterTank(this.log, this.uuid, {
            ...tank,
            usonicBinary: this.deviceData?.usonicBinary,
          }),
          config: tank,
          waterlevel: undefined,
          percentage: undefined,
          lastUpdated: undefined,
        };

        this?.log?.debug?.(
          'Setting up watertank "%s" using trigger pin "%s" and echo pin "%s"',
          tank.name,
          tank.sensorTrigPin,
          tank.sensorEchoPin,
        );
        return;
      }

      let existing = this.#tanks[tank.uuid];

      if (JSON.stringify(existing.config) !== JSON.stringify(tank)) {
        this?.log?.debug?.('Updating watertank "%s"', tank.name);

        existing.instance?.onUpdate?.(tank);
        existing.config = tank;
      }
    });

    if (Object.keys(this.#tanks).length === 0) {
      if (this.irrigationService.testCharacteristic(this.hap.Characteristic.WaterLevel) === true) {
        this.removeCharacteristic(this.irrigationService, this.hap.Characteristic.WaterLevel);
      }
    }
  }

  #setupZones(deviceData = {}, atStart = false) {
    if (Array.isArray(deviceData?.zones) !== true) {
      deviceData.zones = [];
    }

    // HomeKit grouping support.
    // Required when multiple Valve services exist on the same accessory.
    if (deviceData.zones.length > 1) {
      this.serviceLabelService = this.accessory.getService(this.hap.Service.ServiceLabel);

      if (this.serviceLabelService === undefined) {
        this.serviceLabelService = this.accessory.addService(this.hap.Service.ServiceLabel, '', 1);
      }

      this.serviceLabelService.updateCharacteristic(
        this.hap.Characteristic.ServiceLabelNamespace,
        this.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
      );
    }

    // Remove stale HomeKit valve services no longer present in configuration.
    this.accessory.services
      .filter((service) => service.UUID === this.hap.Service.Valve.UUID)
      .forEach((service) => {
        let exists = deviceData.zones.some((zone) => {
          if (typeof zone?.uuid !== 'string' || zone.uuid === '') {
            return false;
          }

          return Number(service.subtype) === crc32(zone.uuid.toUpperCase());
        });

        if (exists === false) {
          this.removeService(service);
        }
      });

    // Remove internal zones no longer configured.
    Object.keys(this.#zones || {}).forEach((uuid) => {
      let exists = deviceData.zones.some((zone) => zone?.uuid === uuid);

      if (exists === false) {
        if (this.#zones[uuid]?.run !== undefined) {
          this.#zones[uuid].endTime = undefined;
        }

        this.#zones[uuid]?.valves?.forEach((valve) => {
          if (valve.isOpen() === true) {
            valve.close();
          }
        });

        if (atStart === false) {
          this?.log?.info?.('Zone "%s" has been removed', this.#zones[uuid]?.config?.name ?? uuid);
        }

        delete this.#zones[uuid];
      }
    });

    // Create / update configured zones.
    deviceData.zones.forEach((zone, index) => {
      if (typeof zone !== 'object' || zone === null || typeof zone.uuid !== 'string' || zone.uuid === '') {
        return;
      }

      let uuidHash = crc32(zone.uuid.toUpperCase());
      let service = this.addService(this.hap.Service.Valve, zone.name, uuidHash);

      // Create new internal zone state if needed.
      if (this.#zones?.[zone.uuid] === undefined) {
        // HomeKit service name.
        this.addCharacteristic(service, this.hap.Characteristic.Name);
        service.updateCharacteristic(this.hap.Characteristic.Name, zone.name);

        // Enable / disable zone.
        this.addCharacteristic(service, this.hap.Characteristic.IsConfigured, {
          onSet: (value) => this.setZoneEnabled(zone, value),
          onGet: () =>
            zone.enabled === true ? this.hap.Characteristic.IsConfigured.CONFIGURED : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
        });

        // Remaining duration.
        this.addCharacteristic(service, this.hap.Characteristic.RemainingDuration, {
          props: { maxValue: this.deviceData.maxRuntime },
        });

        // Runtime.
        this.addCharacteristic(service, this.hap.Characteristic.SetDuration, {
          onSet: (value) => this.setZoneRuntime(zone, value),
          onGet: () => zone.runtime,
          props: { maxValue: this.deviceData.maxRuntime },
        });

        // Zone name.
        this.addCharacteristic(service, this.hap.Characteristic.ConfiguredName, {
          onSet: (value) => this.setZoneName(zone, value),
          onGet: () => zone.name,
        });

        // Active state.
        this.addCharacteristic(service, this.hap.Characteristic.Active, {
          onSet: (value) => this.#processActiveCharacteristic(zone, value, 'valve'),
          onGet: () =>
            this.#zones?.[zone.uuid]?.run !== undefined ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
        });

        // Identifier is stable for the lifetime of this HomeKit service.
        // Set once only when the service is first created.
        this.addCharacteristic(service, this.hap.Characteristic.Identifier);
        service.updateCharacteristic(this.hap.Characteristic.Identifier, uuidHash);

        // ServiceLabelIndex is stable for the lifetime of this HomeKit service.
        // Set once only when the service is first created.
        this.addCharacteristic(service, this.hap.Characteristic.ServiceLabelIndex, {
          onGet: () => index + 1,
        });
        service.updateCharacteristic(this.hap.Characteristic.ServiceLabelIndex, index + 1);

        this.#zones[zone.uuid] = {
          service,
          valves: [],
          config: undefined,

          // Unified runtime state.
          // When undefined -> zone is idle.
          // When object -> zone is actively running.
          run: undefined,

          // Timer control.
          endTime: undefined,

          // Multi-valve sequencing support.
          activeValveIndex: 0,
        };

        this.irrigationService.addLinkedService(service);

        if (atStart === false) {
          this?.log?.info?.('Zone "%s" has been added', zone.name);
        }
      }

      let zoneData = this.#zones[zone.uuid];

      if (zone.enabled !== true && zoneData.run !== undefined) {
        this.setZoneActive(zone, this.hap.Characteristic.Active.INACTIVE);
      }

      // Relay layout changes require rebuilding the valve objects.
      if (JSON.stringify(zoneData.config?.relayPin) !== JSON.stringify(zone.relayPin)) {
        if (zoneData.run !== undefined) {
          this.setZoneActive(zoneData.config, this.hap.Characteristic.Active.INACTIVE);
        }

        zoneData.valves.forEach((valve) => {
          if (valve.isOpen() === true) {
            valve.close();
          }
        });

        let relayArray = Array.isArray(zone.relayPin) === true ? zone.relayPin : [zone.relayPin];

        zoneData.valves = relayArray
          .filter((relayPin) => Number.isFinite(Number(relayPin)) === true)
          .map(
            (relayPin) =>
              new Valve(this.log, this.uuid, {
                uuid: zone.uuid + '-' + relayPin,
                name: zone.name,
                relayPin,
              }),
          );
      }

      // Update stored config snapshot for later change detection.
      zoneData.config = structuredClone(zone);

      // Keep service display name and HomeKit name in sync.
      if (zoneData.service.displayName !== zone.name) {
        zoneData.service.displayName = zone.name;
      }

      // Update HomeKit state that can legitimately change.
      zoneData.service.updateCharacteristic(this.hap.Characteristic.Name, zone.name);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.ValveType, this.hap.Characteristic.ValveType.IRRIGATION);
      zoneData.service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, zone.name);
      zoneData.service.updateCharacteristic(
        this.hap.Characteristic.IsConfigured,
        zone.enabled === true ? this.hap.Characteristic.IsConfigured.CONFIGURED : this.hap.Characteristic.IsConfigured.NOT_CONFIGURED,
      );
      zoneData.service.updateCharacteristic(this.hap.Characteristic.SetDuration, zone.runtime);

      // If the zone is not actively running, keep HomeKit in a clean idle state.
      if (zoneData.run === undefined) {
        zoneData.service.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.INACTIVE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.InUse, this.hap.Characteristic.InUse.NOT_IN_USE);
        zoneData.service.updateCharacteristic(this.hap.Characteristic.RemainingDuration, 0);
      }
    });
  }

  #setupFlowSensor(deviceData = {}, atStart = false) {
    // No flow pin configured, so remove any existing flow sensor
    if (deviceData.sensorFlowPin === undefined) {
      if (this.#flowSensor !== undefined) {
        this.#flowSensor.onShutdown();
        this.#flowSensor = undefined;

        if (atStart === false) {
          this?.log?.info?.('Flow sensor on "%s" has been removed', this.deviceData.sensorFlowPin);
        }
      }

      return;
    }

    // We do not have an existing flow sensor, so set one up
    if (this.#flowSensor === undefined) {
      this.#flowSensor = new FlowSensor(this.log, this.uuid, {
        sensorPin: deviceData.sensorFlowPin,
        flowRate: deviceData.flowRate,
        leakDetection: deviceData.leakSensor === true,
        leakTimeout: WATER_LEAK_TIMEOUT,
      });

      if (atStart === false) {
        this?.log?.info?.('Flow sensor on "%s" has been added', this.deviceData.sensorFlowPin);
      }

      return;
    }

    // Updated details on an existing flow sensor
    this.#flowSensor.onUpdate({
      sensorPin: deviceData.sensorFlowPin,
      flowRate: deviceData.flowRate,
      leakDetection: deviceData.leakSensor === true,
      leakTimeout: WATER_LEAK_TIMEOUT,
    });
  }

  #setupLeakSensor(deviceData = {}, atStart = false) {
    // HomeKit leak sensor is only useful when leak detection and flow sensing are both configured.
    // This function should be called AFTER flow sensor setup
    if (this.#flowSensor !== undefined && deviceData.leakSensor === true) {
      if (this.leakSensorService === undefined) {
        this.leakSensorService = this.addService(this.hap.Service.LeakSensor, '', 1, {});
        if (atStart === false) {
          this?.log?.info?.('Leak sensor', deviceData.waterLeakAlert === true ? 'with alerting' : '');
        }
      }

      this.leakSensorService.updateCharacteristic(
        this.hap.Characteristic.LeakDetected,
        this.leakDetected === true
          ? this.hap.Characteristic.LeakDetected.LEAK_DETECTED
          : this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );

      return;
    }

    // Leak sensor is no longer configured, so remove the HomeKit service.
    if (this.leakSensorService !== undefined) {
      this.removeService(this.leakSensorService);
      this.leakSensorService = undefined;
      this.leakDetected = false;

      if (atStart === false) {
        this?.log?.info?.('Leak sensor has been removed');
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

    let escapeAttribute = (value) => {
      return escapeHTML(value).replaceAll('`', '&#096;');
    };

    let dashboardButton = (className, title, action, payload, content, disabled = false, isBuiltIn = false, target = undefined) => {
      return (
        '<button class="' +
        escapeAttribute(className) +
        '" title="' +
        escapeAttribute(title) +
        '" ' +
        (isBuiltIn === true
          ? 'data-action="' + escapeAttribute(action) + '"'
          : 'data-send-action="' + escapeAttribute(action) + '" data-payload="' + escapeAttribute(JSON.stringify(payload ?? {})) + '"') +
        (target !== undefined ? ' data-target="' + escapeAttribute(target) + '"' : '') +
        (disabled === true ? ' disabled' : '') +
        '>' +
        content +
        '</button>'
      );
    };

    let collapseButton = (className, target, content) => {
      return (
        '<button class="' +
        escapeAttribute(className) +
        '" data-action="toggleCollapse" data-target="' +
        escapeAttribute(target) +
        '">' +
        content +
        '</button>'
      );
    };

    let formatLastRun = (time) => {
      if (Number.isFinite(Number(time)) !== true) {
        return 'Never run';
      }

      let lastRunTime = Number(time);

      // History time is stored in Unix seconds, convert to milliseconds.
      if (lastRunTime < 1000000000000) {
        lastRunTime = lastRunTime * 1000;
      }

      let seconds = Math.max(0, Math.floor((Date.now() - lastRunTime) / 1000));
      let days = Math.floor(seconds / 86400);
      let hours = Math.floor(seconds / 3600);
      let minutes = Math.floor(seconds / 60);

      if (days > 0) {
        return 'Last run ' + days + ' day' + (days === 1 ? '' : 's') + ' ago';
      }

      if (hours > 0) {
        return 'Last run ' + hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
      }

      if (minutes > 0) {
        return 'Last run ' + minutes + ' min ago';
      }

      return 'Last run just now';
    };

    let formatDuration = (seconds) => {
      let duration = Number.isFinite(Number(seconds)) === true ? Math.max(0, Math.floor(Number(seconds))) : 0;
      let minutes = Math.floor(duration / 60);
      let remainingSeconds = duration % 60;

      return String(minutes).padStart(2, '0') + ':' + String(remainingSeconds).padStart(2, '0');
    };

    let sprinklerIcon = () => {
      return '<svg viewBox="0 0 24 24"><path d="M12 14v7"/><path d="M8 21h8"/><path d="M9 14h6"/><path d="M12 4v3"/><path d="M6 7l2 2"/><path d="M18 7l-2 2"/><path d="M4 12h3"/><path d="M20 12h-3"/></svg>';
    };

    let checkIcon = () => {
      return '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
    };

    let waterIcon = () => {
      return '<svg viewBox="0 0 24 24"><path d="M12 3C12 3 6 10 6 14a6 6 0 0 0 12 0c0-4-6-11-6-11z"/></svg>';
    };

    let bucketIcon = () => {
      return '<svg viewBox="0 0 24 24"><path d="M6 4h12"/><path d="M7 4l1 17h8l1-17"/><path d="M9 9h6"/></svg>';
    };

    let getWaterUsageDays = (days = 7) => {
      let usage = [];

      // Create empty day buckets (today - N days)
      //
      // Each entry represents a calendar day (midnight → midnight)
      // and will be populated with total litres used on that day.
      for (let index = days - 1; index >= 0; index--) {
        let date = new Date();

        // Normalise to midnight so comparisons are consistent
        date.setHours(0, 0, 0, 0);

        // Move back N days
        date.setDate(date.getDate() - index);

        usage.push({
          date, // Normalised Date object
          label: date.toLocaleDateString([], { weekday: 'short' }), // e.g. Mon, Tue
          water: 0, // Accumulated litres for this day
        });
      }

      // Iterate through all zones and collect history
      // We aggregate across ALL zones to produce a system-wide total.
      Object.values(this.#zones || {}).forEach((zoneData) => {
        // Pull Eve history entries for this zone (if available)
        let history =
          typeof this?.historyService?.getHistory === 'function' && zoneData?.service !== undefined
            ? this.historyService.getHistory(this.hap.Service.Valve, zoneData.service.subtype)
            : [];

        // Process each history entry
        history.forEach((entry) => {
          // Only consider completed runs (status === 0)
          // and valid water usage values
          if (Number(entry?.status) !== 0 || Number.isFinite(Number(entry?.water)) !== true) {
            return;
          }

          let time = Number(entry.time);

          // Convert Unix seconds → milliseconds if required
          if (time < 1000000000000) {
            time = time * 1000;
          }

          // Normalise entry time to midnight for grouping
          let entryDate = new Date(time);
          entryDate.setHours(0, 0, 0, 0);

          // Match entry to one of our day buckets
          usage.forEach((day) => {
            if (day.date.getTime() === entryDate.getTime()) {
              // Add water usage (litres) to that day
              day.water = day.water + Number(entry.water);
            }
          });
        });
      });

      return usage;
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
    let systemFlowRate =
      Number.isFinite(Number(this.#lastFlowTime)) === true && Date.now() - Number(this.#lastFlowTime) <= 3000
        ? Number(this.#lastFlowRate)
        : 0;
    let flowRate =
      activeZoneData !== undefined &&
      typeof activeZoneData.run === 'object' &&
      Number.isFinite(Number(activeZoneData.run.flowRate)) === true
        ? Number(activeZoneData.run.flowRate)
        : systemFlowRate;
    let waterUsed =
      activeZoneData !== undefined &&
      typeof activeZoneData.run === 'object' &&
      Number.isFinite(Number(activeZoneData.run.waterUsed)) === true
        ? Number(activeZoneData.run.waterUsed)
        : Number(this.#unassignedWaterUsed);

    let isFlowActive = flowRate > 0;
    let isLeakGracePeriod =
      Number.isFinite(Number(this.lastValveClose)) === true &&
      this.lastValveClose > 0 &&
      Date.now() - Number(this.lastValveClose) <= WATER_LEAK_TIMEOUT;

    let isExpectedFlow = activeZoneData !== undefined || isLeakGracePeriod === true;
    let isUnexpectedFlow = isFlowActive === true && isExpectedFlow === false;

    let enabledZones = Object.values(this.deviceData?.zones || []).filter((zone) => zone?.enabled === true).length;
    let activeZones = Object.values(this.#zones || {}).filter((zone) => zone?.run !== undefined).length;

    // Leak status values.
    let leakConfigured = this.leakSensorService !== undefined;
    let leakStatus = this.leakDetected === true ? 'alert' : 'ok';

    // Render the top system summary strip.
    let renderSummaryCard = () => {
      let isOn = this.deviceData.power === true;
      let html = '';

      html += '<section class="card dashboard-summary-card ' + (isOn ? 'on' : 'off') + '">';
      html += '<div class="dashboard-summary-content">';
      html += dashboardButton(
        'dashboard-power-button',
        isOn ? 'Turn off irrigation system' : 'Turn on irrigation system',
        'power',
        { power: isOn !== true },
        '<svg viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M6.4 7.6a8 8 0 1 0 11.2 0"/></svg>',
      );
      html += '<div class="dashboard-card-text">';
      html += '<div class="dashboard-card-heading">System Power</div>';
      html += '<div class="dashboard-card-title">' + (isOn ? 'Enabled' : 'Disabled') + '</div>';
      html += '<div class="dashboard-card-sub">';
      html += isOn ? 'Irrigation zones can run normally' : 'All zones are prevented from running';
      html += '</div>';
      html += '</div>';

      html += '<div class="dashboard-summary-stat">';
      html += '<svg viewBox="0 0 24 24"><path d="M5 19V9"/><path d="M10 19V5"/><path d="M15 19v-7"/><path d="M20 19V8"/></svg>';
      html += '<div>';
      html += '<div class="dashboard-summary-stat-title">Zones</div>';
      html += '<div class="dashboard-summary-stat-value">' + activeZones + ' Active / ' + enabledZones + ' Enabled</div>';
      html += '</div>';
      html += '</div>';

      html +=
        '<div class="dashboard-summary-stat dashboard-flow-stat ' +
        (isUnexpectedFlow === true ? 'alert' : isExpectedFlow === true ? 'active' : '') +
        '">';
      html += waterIcon();
      html += '<div>';
      html += '<div class="dashboard-summary-stat-title">Flow</div>';
      html += '<div class="dashboard-summary-stat-value">' + flowRate.toFixed(1) + ' L/min</div>';
      html += '</div>';
      html += '</div>';

      html += '<div class="dashboard-summary-stat dashboard-water-used-stat ' + (isUnexpectedFlow === true ? 'alert' : '') + '">';
      html += bucketIcon();
      html += '<div>';
      html += '<div class="dashboard-summary-stat-title">Water Used</div>';
      html += '<div class="dashboard-summary-stat-value">' + Math.round(waterUsed).toLocaleString() + ' L this run</div>';
      html += '</div>';
      html += '</div>';

      if (leakConfigured === true) {
        html += '<div class="dashboard-summary-stat ' + leakStatus + '">';
        html +=
          this.leakDetected === true
            ? '<svg viewBox="0 0 24 24"><path d="M12 3C12 3 6 10 6 14a6 6 0 0 0 12 0c0-4-6-11-6-11z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>'
            : checkIcon();
        html += '<div>';
        html += '<div class="dashboard-summary-stat-title">Leak</div>';
        html += '<div class="dashboard-summary-stat-value">' + (this.leakDetected === true ? 'Detected' : 'No Leak') + '</div>';
        html += '</div>';
        html += '</div>';
      }

      html += '</div>';
      html += '</section>';

      return html;
    };

    // Render all zone state and manual controls.
    let renderZonesSection = () => {
      let html = '';

      html += '<div class="dashboard-section-title">';
      html += '<div class="card-title">Zones</div>';
      html += '<div class="list-sub">Manage your irrigation zones</div>';
      html += '</div>';

      html += '<section class="card dashboard-card dashboard-zones-card">';

      html += '<div class="dashboard-card-header dashboard-zones-header" data-action="toggleCollapse" data-target="zones-list">';
      html += '<div class="dashboard-card-text">';
      html += '<div class="dashboard-card-heading">All Zones</div>';
      html += '<div class="dashboard-card-sub">';
      html += activeZone !== undefined ? escapeHTML(activeZone.name) + ' currently running' : 'Run a zone manually';
      html += '</div>';
      html += '</div>';
      html += collapseButton('dashboard-collapse-toggle', 'zones-list', '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>');
      html += '</div>';

      html += '<div id="zones-list" class="dashboard-zones-list dashboard-collapse">';

      Object.values(this.deviceData?.zones || []).forEach((zone) => {
        let zoneData = this.#zones?.[zone.uuid];
        let isRunning = zoneData?.run !== undefined;
        let runtime = Number.isFinite(Number(zone.runtime)) === true ? Number(zone.runtime) : 0;

        let historyEntries =
          typeof this?.historyService?.getHistory === 'function' && zoneData?.service !== undefined
            ? this.historyService.getHistory(this.hap.Service.Valve, zoneData.service.subtype)
            : [];

        let lastRunEntry =
          typeof this?.historyService?.lastHistory === 'function' && zoneData?.service !== undefined
            ? this.historyService.lastHistory(this.hap.Service.Valve, zoneData.service.subtype)
            : undefined;

        let completedRuns = historyEntries.filter((entry) => {
          return (
            Number(entry?.status) === 0 &&
            Number.isFinite(Number(entry?.water)) === true &&
            Number(entry.water) > 0 &&
            Number.isFinite(Number(entry?.duration)) === true &&
            Number(entry.duration) > 0
          );
        });

        if (
          lastRunEntry === undefined ||
          Number(lastRunEntry?.status) !== 0 ||
          Number.isFinite(Number(lastRunEntry?.water)) !== true ||
          Number(lastRunEntry.water) <= 0 ||
          Number.isFinite(Number(lastRunEntry?.duration)) !== true ||
          Number(lastRunEntry.duration) <= 0
        ) {
          lastRunEntry = completedRuns.length > 0 ? completedRuns[completedRuns.length - 1] : undefined;
        }

        let lastRun = formatLastRun(lastRunEntry?.time);
        let recentRuns = completedRuns.slice(-5);
        let lastFlowRate =
          recentRuns.length > 0
            ? recentRuns.reduce((total, entry) => total + Number(entry.water) / (Number(entry.duration) / 60), 0) / recentRuns.length
            : 0;
        let estimatedUsage = lastFlowRate > 0 ? Math.round((lastFlowRate * runtime) / 60) : undefined;

        html += '<div class="dashboard-zone-row' + (isRunning === true ? ' running' : '') + '">';

        html += '<div class="dashboard-zone-icon">';
        html += sprinklerIcon();
        html += '</div>';

        html += '<div class="dashboard-zone-main">';
        html += '<div class="dashboard-zone-name">' + escapeHTML(zone.name) + '</div>';
        html += '<div class="dashboard-zone-meta">';
        html += Math.round(runtime / 60) + ' min • ' + (isRunning === true ? 'Currently running' : lastRun);
        html += '</div>';
        html += '</div>';

        html += '<div class="dashboard-zone-stat">';
        html += waterIcon();
        html +=
          '<span>' +
          (isRunning === true ? flowRate.toFixed(1) + ' L/min' : lastFlowRate > 0 ? lastFlowRate.toFixed(1) + ' L/min' : '—') +
          '</span>';
        html += '</div>';

        html += '<div class="dashboard-zone-stat">';
        html += bucketIcon();
        html += '<span>';
        html +=
          isRunning === true
            ? Math.round(waterUsed).toLocaleString() + ' L'
            : estimatedUsage !== undefined
              ? 'Est. ' + estimatedUsage.toLocaleString() + ' L'
              : 'No estimate';
        html += '</span>';
        html += '</div>';

        if (isRunning === true) {
          html += dashboardButton(
            'dashboard-active-stop',
            'Stop active zone',
            'zone',
            { uuid: zone.uuid, active: false },
            '<span class="stop-icon"></span>Stop',
          );
        } else {
          html += dashboardButton(
            'dashboard-zone-run',
            'Run zone',
            'zone',
            { uuid: zone.uuid, active: true },
            '<span class="run-icon"></span>Run',
            zone.enabled !== true || this.deviceData.power !== true,
          );
        }

        if (isRunning === true) {
          html += '<div class="dashboard-zone-active-details">';
          html += '<div class="dashboard-active-progress">';
          html += '<div class="dashboard-active-progress-fill" style="width:' + complete + '%"></div>';
          html += '</div>';

          html += '<div class="dashboard-active-stats">';
          html += '<div class="dashboard-active-stat">';
          html += '<span class="dashboard-active-stat-value">' + complete + '% complete</span>';
          html += '</div>';

          html += '<div class="dashboard-active-stat">';
          html += '<span class="dashboard-active-stat-value">' + formatDuration(remaining) + ' remaining</span>';
          html += '</div>';
          html += '</div>';
          html += '</div>';
        }

        html += '</div>';
      });

      html += '</div>';
      html += '</section>';

      return html;
    };

    // Render water usage history card.
    let renderWaterUsageSection = () => {
      let renderUsageBody = (days = 7, visible = false) => {
        let usage = getWaterUsageDays(days);
        let total = usage.reduce((sum, day) => sum + Number(day.water), 0);
        let average = usage.length > 0 ? Math.round(total / usage.length) : 0;
        let maxWater = Math.max(...usage.map((day) => Number(day.water)), 1);
        let html = '';

        html +=
          '<div class="dashboard-usage-body" data-visible-group="usage-range" data-visible-value="' +
          days +
          '"' +
          (visible !== true ? ' hidden' : '') +
          '>';

        html += '<div class="dashboard-usage-chart dashboard-usage-chart-' + days + '">';

        usage.forEach((day, index) => {
          let water = Math.round(Number(day.water));
          let height = water > 0 ? Math.max(8, Math.round(Math.pow(water / maxWater, 0.7) * 100)) : 6;
          let showDate = days !== 30 || index % 5 === 0 || index === usage.length - 1;
          let dayLabel = days === 30 ? '' : day.label;
          let dateLabel = showDate === true ? day.date.toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';

          html += '<div class="dashboard-usage-day">';
          html += '<div class="dashboard-usage-value">' + (water > 0 ? water.toLocaleString() + ' L' : '') + '</div>';
          html += '<div class="dashboard-usage-bar-wrap">';
          html +=
            '<div class="dashboard-usage-bar" title="' +
            water.toLocaleString() +
            ' L on ' +
            escapeAttribute(day.date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })) +
            '" style="height:' +
            height +
            '%"></div>';
          html += '</div>';
          html += '<div class="dashboard-usage-label">' + escapeHTML(dayLabel) + '</div>';
          html += '<div class="dashboard-usage-date">' + escapeHTML(dateLabel) + '</div>';
          html += '</div>';
        });

        html += '</div>';

        html += '<div class="dashboard-usage-footer">';
        html += '<div class="dashboard-usage-total">';
        html += waterIcon();
        html += '<div>';
        html += '<div class="dashboard-usage-footer-label">Total (' + days + ' days)</div>';
        html += '<div class="dashboard-usage-footer-value">' + Math.round(total).toLocaleString() + ' L</div>';
        html += '</div>';
        html += '</div>';

        html += '<div class="dashboard-usage-average">';
        html += '<svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 16l4-5 3 3 5-8"/></svg>';
        html += '<div>';
        html += '<div class="dashboard-usage-footer-label">Daily average</div>';
        html += '<div class="dashboard-usage-footer-value">' + average.toLocaleString() + ' L</div>';
        html += '</div>';
        html += '</div>';
        html += '</div>';

        html += '</div>';

        return html;
      };

      let html = '';

      html += '<section class="card dashboard-card dashboard-usage-card" data-visible-root>';
      html += '<div class="dashboard-usage-header">';
      html += '<div>';
      html += '<div class="dashboard-card-heading">Water Usage</div>';
      html += '<div class="dashboard-card-sub">Total water used per day</div>';
      html += '</div>';

      html += '<select class="dashboard-usage-range" data-action="switchVisible" data-target-group="usage-range">';
      html += '<option value="7" selected>Last 7 days</option>';
      html += '<option value="14">Last 14 days</option>';
      html += '<option value="30">Last 30 days</option>';
      html += '</select>';

      html += '</div>';

      html += renderUsageBody(7, true);
      html += renderUsageBody(14);
      html += renderUsageBody(30);

      html += '</section>';

      return html;
    };

    // Render configured water tank cards.
    let renderTankSection = () => {
      let html = '';

      html += '<div class="dashboard-section-title">';
      html += '<div class="card-title">Water Tanks</div>';
      html += '<div class="list-sub">Current water levels in configured tanks</div>';
      html += '</div>';

      html += '<div class="dashboard-tank-grid">';

      Object.values(this.deviceData?.tanks || []).forEach((tankConfig) => {
        let tank = this.#tanks?.[tankConfig.uuid];
        let percentage = Number.isFinite(Number(tank?.percentage)) === true ? Math.round(Number(tank.percentage)) : 0;
        let fillHeight = percentage === 0 ? 2 : Math.round(Math.pow(percentage / 100, 0.8) * 100);
        let emptyClass = percentage === 0 ? ' tank-empty' : '';
        let capacity = Number.isFinite(Number(tankConfig?.capacity)) === true ? Number(tankConfig.capacity) : 0;
        let litres = Math.round((capacity * percentage) / 100);
        let name = typeof tankConfig?.name === 'string' && tankConfig.name.trim() !== '' ? tankConfig.name.trim() : 'Water Tank';
        let updated =
          Number.isFinite(Number(tank?.lastUpdated)) === true
            ? new Date(tank.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : undefined;
        let stale = Number.isFinite(Number(tank?.lastUpdated)) === true && Date.now() - Number(tank.lastUpdated) > 300000;

        html += '<section class="card dashboard-card dashboard-tank-card">';

        html += '<div class="dashboard-card-text">';
        html += '<div class="dashboard-card-heading">' + escapeHTML(name) + '</div>';
        html += '</div>';

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

      return html;
    };

    let css = `
/* Dashboard layout */
.irrigation-dashboard .dashboard-section,
.irrigation-dashboard .dashboard-inner {
  max-width: 980px;
}

/* Collapsible sections */
.irrigation-dashboard .dashboard-collapse {
  max-height: 0;
  overflow: hidden;
  opacity: 0;
  transition: max-height 0.25s ease, opacity 0.2s ease;
}

.irrigation-dashboard .dashboard-collapse.open {
  max-height: 2000px;
  opacity: 1;
}

/* Zones list can grow freely */
.irrigation-dashboard .dashboard-zones-list.dashboard-collapse.open {
  max-height: none;
  overflow: visible;
}

/* Common card system */
.irrigation-dashboard .dashboard-card {
  width: 100%;
  max-width: 920px;
  padding: 16px 22px;
  margin-bottom: 34px;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 12px;
  background: var(--card, #fff);
  box-sizing: border-box;
}

/* Common card header layout */
.irrigation-dashboard .dashboard-card-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 16px;
  align-items: center;
}

.irrigation-dashboard .dashboard-card-text {
  min-width: 0;
}

.irrigation-dashboard .dashboard-card-heading {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}

.irrigation-dashboard .dashboard-card-title {
  margin-top: 4px;
  font-size: 16px;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-card-sub {
  margin-top: 5px;
  font-size: 14px;
  color: var(--muted);
}

/* Toggle button */
.irrigation-dashboard .dashboard-collapse-toggle {
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
}

.irrigation-dashboard .dashboard-collapse-toggle svg {
  width: 20px;
  height: 20px;
  stroke: currentColor;
  stroke-width: 2.5;
  fill: none;
  transition: transform 0.25s ease;
}

.irrigation-dashboard .dashboard-collapse-toggle.open svg {
  transform: rotate(180deg);
}

/* Shared SVG icon styling */
.irrigation-dashboard svg {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.irrigation-dashboard .dashboard-power-button svg {
  width: 26px;
  height: 26px;
  stroke-width: 2.6;
}

.irrigation-dashboard .dashboard-summary-stat svg {
  width: 24px;
  height: 24px;
  color: #0f6fe8;
  stroke-width: 2.2;
  flex-shrink: 0;
}

.irrigation-dashboard .dashboard-zone-icon svg,
.irrigation-dashboard .dashboard-zone-stat svg {
  width: 18px;
  height: 18px;
  color: #0f6fe8;
  stroke-width: 2.2;
}

/* System summary */
.irrigation-dashboard .dashboard-summary-card {
  margin-bottom: 36px;
  border-color: rgba(49, 182, 75, 0.22);
  background: rgba(148, 163, 184, 0.035);
}

.irrigation-dashboard .dashboard-summary-card.off {
  border-color: rgba(148, 163, 184, 0.25);
}

.irrigation-dashboard .dashboard-summary-card .dashboard-card-title {
  color: #2f7d43;
}

.irrigation-dashboard .dashboard-summary-card.off .dashboard-card-title {
  color: #64748b;
}

.irrigation-dashboard .dashboard-summary-content {
  display: grid;
  grid-template-columns: 64px minmax(260px, 1fr) repeat(4, minmax(110px, auto));
  gap: 20px;
  align-items: center;
}

.irrigation-dashboard .dashboard-summary-stat {
  min-height: 48px;
  padding-left: 22px;
  border-left: 1px solid rgba(0, 0, 0, 0.08);
  display: flex;
  align-items: center;
  gap: 10px;
}

.irrigation-dashboard .dashboard-summary-stat-title {
  color: var(--text);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.15;
}

.irrigation-dashboard .dashboard-summary-stat-value {
  margin-top: 3px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.15;
}

/* Power button */
.irrigation-dashboard .dashboard-power-button {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease, transform 0.15s ease;
}

.irrigation-dashboard .dashboard-summary-card.off .dashboard-power-button {
  border: 2px solid #94a3b8;
  background: rgba(148, 163, 184, 0.08);
  color: #64748b;
}

.irrigation-dashboard .dashboard-summary-card.on .dashboard-power-button {
  border: 2px solid #2f7d43;
  background: rgba(49, 182, 75, 0.08);
  color: #2f7d43;
}

.irrigation-dashboard .dashboard-power-button:hover {
  transform: translateY(-1px);
}

.irrigation-dashboard .dashboard-summary-card.off .dashboard-power-button:hover {
  background: rgba(148, 163, 184, 0.14);
}

.irrigation-dashboard .dashboard-summary-card.on .dashboard-power-button:hover {
  background: rgba(49, 182, 75, 0.16);
}

.irrigation-dashboard .dashboard-power-button:hover svg {
  transform: scale(1.05);
}

/* Flow state in summary */
.irrigation-dashboard .dashboard-flow-stat.active svg,
.irrigation-dashboard .dashboard-flow-stat.active .dashboard-summary-stat-value {
  color: #2f7d43;
}

.irrigation-dashboard .dashboard-flow-stat.alert svg,
.irrigation-dashboard .dashboard-flow-stat.alert .dashboard-summary-stat-title,
.irrigation-dashboard .dashboard-flow-stat.alert .dashboard-summary-stat-value {
  color: #d94444;
}

/* Unexpected water usage in summary */
.irrigation-dashboard .dashboard-water-used-stat.alert svg,
.irrigation-dashboard .dashboard-water-used-stat.alert .dashboard-summary-stat-title,
.irrigation-dashboard .dashboard-water-used-stat.alert .dashboard-summary-stat-value {
  color: #d94444;
}

/* Leak alert state in summary */
.irrigation-dashboard .dashboard-summary-stat.alert .dashboard-summary-stat-title,
.irrigation-dashboard .dashboard-summary-stat.alert .dashboard-summary-stat-value,
.irrigation-dashboard .dashboard-summary-stat.alert svg {
  color: #d94444;
}

/* Zones */
.irrigation-dashboard .dashboard-zones-card {
  padding: 0;
  overflow: hidden;
}

.irrigation-dashboard .dashboard-zones-header {
  padding: 16px 22px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 16px;
  align-items: center;
  cursor: pointer;
}

.irrigation-dashboard .dashboard-zones-list {
  border-top: 1px solid rgba(0,0,0,0.08);
}

.irrigation-dashboard .dashboard-zone-row {
  display: grid;
  grid-template-columns: 44px 1fr 130px 140px 110px;
  gap: 14px;
  align-items: center;
  padding: 12px 22px;
  border-top: 1px solid rgba(0,0,0,0.06);
}

.irrigation-dashboard .dashboard-zone-row.running {
  background: rgba(15, 111, 232, 0.035);
}

.irrigation-dashboard .dashboard-zone-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(15,111,232,0.08);
  border: 1px solid rgba(15,111,232,0.16);
  display: flex;
  align-items: center;
  justify-content: center;
}

.irrigation-dashboard .dashboard-zone-name {
  font-weight: 700;
}

.irrigation-dashboard .dashboard-zone-meta {
  margin-top: 3px;
  font-size: 13px;
  color: var(--muted);
}

.irrigation-dashboard .dashboard-zone-row.running .dashboard-zone-meta {
  color: #0f6fe8;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-zone-stat {
  display: flex;
  gap: 7px;
  font-size: 13px;
  color: var(--muted);
}

.irrigation-dashboard .dashboard-zone-run,
.irrigation-dashboard .dashboard-active-stop {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.irrigation-dashboard .dashboard-zone-run {
  border: 1px solid rgba(15,111,232,0.22);
  background: rgba(15,111,232,0.045);
  color: #0f6fe8;
}

.irrigation-dashboard .dashboard-active-stop {
  border: 1px solid rgba(217,68,68,0.25);
  background: rgba(217,68,68,0.05);
  color: #d94444;
}

.irrigation-dashboard .dashboard-zone-active-details {
  grid-column: 1 / -1;
  padding-left: 58px;
}

.irrigation-dashboard .dashboard-active-progress {
  height: 6px;
  border-radius: 999px;
  background: rgba(0,0,0,0.08);
  overflow: hidden;
  margin: 8px 0;
}

.irrigation-dashboard .dashboard-active-progress-fill {
  height: 100%;
  background: var(--accent);
}
  
/* Water usage */
.irrigation-dashboard .dashboard-usage-card {
  max-width: 620px;
}

.irrigation-dashboard .dashboard-usage-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}

.irrigation-dashboard .dashboard-usage-body[hidden] {
  display: none;
}

.irrigation-dashboard .dashboard-usage-range {
  height: 34px;
  padding: 0 34px 0 12px;
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 8px;
  background: var(--card, #fff);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.irrigation-dashboard .dashboard-usage-chart {
  height: 210px;
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 14px;
  align-items: end;
  padding: 16px 0 8px;
  border-bottom: 1px solid rgba(0,0,0,0.1);
}

.irrigation-dashboard .dashboard-usage-chart-14 {
  grid-template-columns: repeat(14, 1fr);
  gap: 8px;
}

.irrigation-dashboard .dashboard-usage-chart-30 {
  grid-template-columns: repeat(30, 1fr);
  gap: 5px;
}

.irrigation-dashboard .dashboard-usage-day {
  height: 100%;
  display: grid;
  grid-template-rows: 22px 1fr auto auto;
  gap: 6px;
  text-align: center;
  min-width: 0;
}

.irrigation-dashboard .dashboard-usage-value {
  color: #0f6fe8;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  margin-bottom: 4px;
  height: 18px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.irrigation-dashboard .dashboard-usage-bar-wrap {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-height: 0;
}

.irrigation-dashboard .dashboard-usage-bar {
  width: 34px;
  min-height: 6px;
  border-radius: 5px 5px 0 0;
  background: linear-gradient(180deg, #60a5fa 0%, #2563eb 100%);
  box-shadow: 0 4px 10px rgba(37,99,235,0.18);
  opacity: 0.9;
}

.irrigation-dashboard .dashboard-usage-chart-14 .dashboard-usage-bar {
  width: 24px;
}

.irrigation-dashboard .dashboard-usage-chart-30 .dashboard-usage-day {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  text-align: center;
  min-width: 0;
}

.irrigation-dashboard .dashboard-usage-chart-30 .dashboard-usage-bar-wrap {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.irrigation-dashboard .dashboard-usage-chart-30 .dashboard-usage-bar {
  width: 16px;
  border-radius: 4px 4px 0 0;
}

.irrigation-dashboard .dashboard-usage-bar:hover {
  filter: brightness(1.1);
}

.irrigation-dashboard .dashboard-usage-day:last-child .dashboard-usage-bar {
  box-shadow: 0 0 0 1px rgba(37,99,235,0.15);
}

.irrigation-dashboard .dashboard-usage-label {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.irrigation-dashboard .dashboard-usage-date {
  color: var(--muted);
  font-size: 11px;
}

.irrigation-dashboard .dashboard-usage-chart-14 .dashboard-usage-label {
  font-size: 11px;
}

.irrigation-dashboard .dashboard-usage-chart-14 .dashboard-usage-date {
  font-size: 10px;
}

.irrigation-dashboard .dashboard-usage-chart-30 .dashboard-usage-value,
.irrigation-dashboard .dashboard-usage-chart-30 .dashboard-usage-label {
  display: none;
}

.irrigation-dashboard .dashboard-usage-chart-30 .dashboard-usage-date {
  min-height: 14px;
  color: var(--muted);
  font-size: 9px;
  white-space: nowrap;
}

.irrigation-dashboard .dashboard-usage-footer {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  padding-top: 18px;
}

.irrigation-dashboard .dashboard-usage-total,
.irrigation-dashboard .dashboard-usage-average {
  display: flex;
  align-items: center;
  gap: 12px;
}

.irrigation-dashboard .dashboard-usage-average {
  padding-left: 22px;
  border-left: 1px solid rgba(0,0,0,0.08);
}

.irrigation-dashboard .dashboard-usage-footer svg {
  width: 26px;
  height: 26px;
  color: #0f6fe8;
  stroke-width: 2.2;
  flex-shrink: 0;
}

.irrigation-dashboard .dashboard-usage-footer-label {
  color: var(--muted);
  font-size: 13px;
}

.irrigation-dashboard .dashboard-usage-footer-value {
  margin-top: 3px;
  color: var(--text);
  font-size: 16px;
  font-weight: 700;
}

/* Water tanks */
.irrigation-dashboard .dashboard-tank-card {
  width: 300px;
  max-width: 90%;
  padding: 20px 18px;
  margin-right: auto;
}

.irrigation-dashboard .dashboard-tank-card .dashboard-card-heading {
  font-size: 16px;
  margin-bottom: 16px;
}

.irrigation-dashboard .dashboard-tank-body {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 26px;
}

.irrigation-dashboard .dashboard-tank-stats {
  text-align: center;
  min-width: 92px;
}

.irrigation-dashboard .dashboard-tank-percent {
  color: #0f6fe8;
  font-size: 28px;
  line-height: 1;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-tank-litres {
  margin-top: 8px;
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

.irrigation-dashboard .tank-graphic {
  position: relative;
  width: 92px;
  height: 118px;
  border: 2px solid #94a3b8;
  border-radius: 50% / 12%;
  overflow: hidden;
  background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
}

.irrigation-dashboard .tank-graphic::before {
  content: '';
  position: absolute;
  left: -2px;
  right: -2px;
  top: -2px;
  height: 22px;
  border: 2px solid #94a3b8;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.72);
  z-index: 4;
}

.irrigation-dashboard .tank-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(180deg, #93c5fd 0%, #3b82f6 60%, #1d4ed8 100%);
  transition: height 0.4s ease;
}

.irrigation-dashboard .tank-fill.tank-empty {
  opacity: 0.35;
  background: linear-gradient(180deg, #93c5fd 0%, #60a5fa 100%);
}

.irrigation-dashboard .tank-fill::before {
  content: '';
  position: absolute;
  left: -4%;
  right: -4%;
  top: -8px;
  height: 16px;
  border-radius: 50%;
  background: rgba(147, 197, 253, 0.6);
}

.irrigation-dashboard .tank-shine {
  position: absolute;
  inset: 10px auto 12px 14px;
  width: 20px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(255,255,255,0.42), rgba(255,255,255,0.04));
  z-index: 4;
}

/* Section spacing */
.irrigation-dashboard .dashboard-section-title {
  margin: 28px 0 14px;
}

.irrigation-dashboard .dashboard-section-title .card-title {
  font-size: 18px;
  font-weight: 700;
}

.irrigation-dashboard .dashboard-section-title .list-sub {
  font-size: 14px;
  margin-top: 4px;
}

.irrigation-dashboard .dashboard-zones-card,
.irrigation-dashboard .dashboard-tank-grid {
  margin-bottom: 36px;
}

.irrigation-dashboard .dashboard-tank-grid {
  margin-top: 10px;
}

/* Responsive */
@media (max-width: 900px) {
  .irrigation-dashboard .dashboard-summary-content {
    grid-template-columns: 64px 1fr;
  }

  .irrigation-dashboard .dashboard-summary-stat {
    grid-column: 1 / -1;
    padding-left: 0;
    border-left: 0;
  }

  .irrigation-dashboard .dashboard-zone-row {
    grid-template-columns: 44px 1fr;
  }

  .irrigation-dashboard .dashboard-zone-stat,
  .irrigation-dashboard .dashboard-zone-run,
  .irrigation-dashboard .dashboard-active-stop {
    grid-column: 1 / -1;
  }

  .irrigation-dashboard .dashboard-zone-active-details {
    padding-left: 0;
  }

  .irrigation-dashboard .dashboard-usage-card {
    max-width: 920px;
  }

  .irrigation-dashboard .dashboard-usage-chart {
    gap: 8px;
  }

  .irrigation-dashboard .dashboard-usage-bar {
    width: 24px;
  }

  .irrigation-dashboard .dashboard-usage-footer {
    grid-template-columns: 1fr;
  }

  .irrigation-dashboard .dashboard-usage-average {
    padding-left: 0;
    border-left: 0;
  }
}
`;

    let html = '';

    html += '<div class="irrigation-dashboard">';
    html += '<section class="dashboard-inner">';

    html += renderSummaryCard();
    html += renderZonesSection();
    html += renderWaterUsageSection();
    html += renderTankSection();

    html += '</section>';
    html += '</div>';

    return { type: 'html', html, css };
  }
}
