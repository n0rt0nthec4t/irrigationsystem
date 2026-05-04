// Irrigation System (HAP-NodeJS)
//
// Standalone HomeKit irrigation controller built on HAP-NodeJS.
// Provides control of irrigation zones, water tanks, flow monitoring,
// and optional leak detection with EveHome history support.
//
// Features:
// - Multi-zone irrigation control (single active zone)
// - Water tank level monitoring (ultrasonic sensors)
// - Flow sensor integration for usage tracking and leak detection
// - Optional virtual power switch for system control
// - Configurable via built-in HomeKitUI web interface
//
// Requirements:
// - Raspberry Pi with GPIO access
// - /boot/config.txt must include: dtoverlay=gpio-no-irq
//
// References:
// - https://github.com/sfeakes/SprinklerD
// - https://github.com/geoffreypetri/water-flow-sensor
//
// TODO:
// - Detect valve current draw and prevent overload conditions
// - Scheduling via Eve Home (Aqua)
// - Integrate Apple WeatherKit for weather-aware irrigation
//
// Code version: 2026.05.04
// Mark Hulskamp
'use strict';

// Define HAP-NodeJS module requirements
import HAP from '@homebridge/hap-nodejs';

// Define nodejs module requirements
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Import our modules
import IrrigationSystem from './system.js';

import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'irrigationsystem';
HomeKitDevice.PLATFORM_NAME = 'IrrigationSystem';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.EVEHOME = HomeKitHistory;

import HomeKitUI from './HomeKitUI.js';

import Logger from './logger.js';
const log = Logger.withPrefix(HomeKitDevice.PLATFORM_NAME);

import { crc32 } from './utils.js';

// Define constants
const { version } = createRequire(import.meta.url)('../package.json'); // Import the package.json file to get the version number
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const ACCESSORY_PINCODE = '031-45-154'; // Default HomeKit pairing code
const CONFIGURATION_FILE = 'IrrigationSystem_config.json'; // Default configuration file name
const CONFIG_SCHEMA_FILE = path.join(__dirname, './config.schema.json');

// General helper functions
function loadConfiguration(filename) {
  if (typeof filename !== 'string' || filename === '' || fs.existsSync(filename) === false) {
    return;
  }

  let config = undefined;

  try {
    let loadedConfig = JSON.parse(fs.readFileSync(filename, 'utf8').trim());

    config = {
      power: false,
      pauseTimeout: 0,
      serialNumber: crc32(crypto.randomUUID().toUpperCase()).toString(),
      hkUsername: crypto
        .randomBytes(6)
        .toString('hex')
        .toUpperCase()
        .split(/(..)/)
        .filter((s) => s)
        .join(':'),
      tanks: [],
      zones: [],
      programs: {
        enabled: false,
        schedules: [],
      },
      options: {
        waterLeakAlert: false,
        sensorFlowPin: undefined,
        flowRate: 0.0,
        maxRuntime: 7200,
        latitude: 0.0,
        longitude: 0.0,
        leakSensor: false,
        elevation: 0,
        eveHistory: true,
        powerSwitch: false,
        usonicBinary: '',
        debug: false,
        hkPairingCode: ACCESSORY_PINCODE,
        webUIPort: 0,
      },
    };

    Object.entries(loadedConfig).forEach(([key, value]) => {
      if (key === 'power') {
        config.power = (typeof value === 'string' && value.toUpperCase() === 'ON') || value === true;
      }

      if (key === 'pauseTimeout') {
        config.pauseTimeout = Number.isFinite(Number(value)) === true && Number(value) > 0 ? Number(value) : 0;
      }

      if (key === 'serialNumber' && typeof value === 'string' && value !== '') {
        config.serialNumber = value.trim();
      }

      if (key === 'hkUsername' && typeof value === 'string' && HomeKitDevice.MAC_ADDR.test(value) === true) {
        config.hkUsername = value;
      }

      if (key === 'tanks' && Array.isArray(value) === true) {
        // Validate tanks section
        let unnamedCount = 1;

        value.forEach((tank) => {
          let tempTank = {
            uuid: typeof tank?.uuid === 'string' && tank.uuid !== '' ? tank.uuid.trim() : crypto.randomUUID(),
            name:
              typeof tank?.name === 'string' && tank.name !== ''
                ? HomeKitDevice.makeValidHKName(tank.name.trim())
                : 'Tank ' + unnamedCount++,
            enabled: tank?.enabled === true,
            capacity: Number.isFinite(Number(tank?.capacity)) === true && Number(tank.capacity) > 0 ? Number(tank.capacity) : 0,
            sensorTrigPin:
              Number.isFinite(Number(tank?.sensorTrigPin)) === true &&
              Number.isFinite(Number(tank?.sensorEchoPin)) === true &&
              Number(tank.sensorTrigPin) >= 0 &&
              Number(tank.sensorTrigPin) <= 26
                ? Number(tank.sensorTrigPin)
                : undefined,
            sensorEchoPin:
              Number.isFinite(Number(tank?.sensorEchoPin)) === true &&
              Number.isFinite(Number(tank?.sensorTrigPin)) === true &&
              Number(tank.sensorEchoPin) >= 0 &&
              Number(tank.sensorEchoPin) <= 26
                ? Number(tank.sensorEchoPin)
                : undefined,
            sensorHeight:
              Number.isFinite(Number(tank?.sensorHeight)) === true && Number(tank.sensorHeight) > 0 ? Number(tank.sensorHeight) : 0,
            minimumLevel:
              Number.isFinite(Number(tank?.minimumLevel)) === true && Number(tank.minimumLevel) > 0 ? Number(tank.minimumLevel) : 0,
          };

          if (tempTank.minimumLevel > tempTank.sensorHeight) {
            tempTank.minimumLevel = tempTank.sensorHeight;
          }

          config.tanks.push(tempTank);
        });
      }

      if (key === 'zones' && Array.isArray(value) === true) {
        // Validate zones section
        let unnamedCount = 1;

        value.forEach((zone) => {
          let tempZone = {
            uuid: typeof zone?.uuid === 'string' && zone.uuid !== '' ? zone.uuid.trim() : crypto.randomUUID(),
            name:
              typeof zone?.name === 'string' && zone.name !== ''
                ? HomeKitDevice.makeValidHKName(zone.name.trim())
                : 'Zone ' + unnamedCount++,
            enabled: zone?.enabled === true,
            runtime: Number.isFinite(Number(zone?.runtime)) === true ? Number(zone.runtime) : 300, // 5mins by default
            relayPin:
              Number.isFinite(Number(zone?.relayPin)) === true && Number(zone.relayPin) >= 0 && Number(zone.relayPin) <= 26
                ? Number(zone.relayPin)
                : undefined,
          };

          if (tempZone.relayPin === undefined && Array.isArray(zone?.relayPin) === true) {
            // Since multiple relay pins, we'll assume a relaypin group. validate it though
            tempZone.relayPin = [];
            zone.relayPin.forEach((pin) => {
              if (Number.isFinite(Number(pin)) === true && Number(pin) >= 0 && Number(pin) <= 26) {
                tempZone.relayPin.push(Number(pin));
              }
            });
          }

          config.zones.push(tempZone);
        });
      }

      if (key === 'programs' && value !== null && Array.isArray(value) === false && typeof value === 'object') {
        // Validate programs section
        config.programs.enabled = value?.enabled === true;
        config.programs.schedules = Array.isArray(value?.schedules) === true ? value.schedules : [];
      }

      if (key === 'options' && value !== null && Array.isArray(value) === false && typeof value === 'object') {
        config.options.leakSensor = value?.leakSensor === true;
        config.options.waterLeakAlert = value?.waterLeakAlert === true;
        config.options.sensorFlowPin =
          Number.isFinite(Number(value?.sensorFlowPin)) === true && Number(value.sensorFlowPin) >= 0 && Number(value.sensorFlowPin) <= 26
            ? Number(value.sensorFlowPin)
            : undefined;
        config.options.flowRate = Number.isFinite(Number(value?.flowRate)) === true ? Number(value.flowRate) : 0.0;
        config.options.maxRuntime =
          Number.isFinite(Number(value?.maxRuntime)) === true && Number(value.maxRuntime) > 0 ? Number(value.maxRuntime) : 7200;
        config.options.latitude =
          Number.isFinite(Number(value?.latitude)) === true && Number(value.latitude) >= -90 && Number(value.latitude) <= 90
            ? Number(value.latitude)
            : 0.0;
        config.options.longitude =
          Number.isFinite(Number(value?.longitude)) === true && Number(value.longitude) >= -180 && Number(value.longitude) <= 180
            ? Number(value.longitude)
            : 0.0;
        config.options.elevation = Number.isFinite(Number(value?.elevation)) === true ? Number(value.elevation) : 0;
        config.options.eveHistory = value?.eveHistory === true;
        config.options.powerSwitch = value?.powerSwitch === true;
        config.options.usonicBinary =
          typeof value?.usonicBinary === 'string' && value.usonicBinary.trim() !== '' ? value.usonicBinary.trim() : undefined;
        config.options.debug = value?.debug === true;
        config.options.hkPairingCode =
          HomeKitDevice.HK_PIN_3_2_3.test(value?.hkPairingCode) === true || HomeKitDevice.HK_PIN_4_4.test(value?.hkPairingCode) === true
            ? value.hkPairingCode
            : ACCESSORY_PINCODE;
        config.options.webUIPort =
          Number.isFinite(Number(value?.webUIPort)) === true && Number(value.webUIPort) > 0 && Number(value.webUIPort) <= 65535
            ? Number(value.webUIPort)
            : 0;
      }
    });

    // Clamp each zone runtime to maxRuntime
    config.zones.forEach((zone) => {
      if (zone.runtime > config.options.maxRuntime) {
        zone.runtime = config.options.maxRuntime;
      }
    });

    // Fix up power state after processing config. If we have a paused timeout set, system will be off
    config.power = config.power === true && config.pauseTimeout === 0;

    // Write config backout!!
    fs.writeFileSync(filename, JSON.stringify(config, null, 2) + '\n');

    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Empty
  }

  return config;
}

// Startup code
log.success(HomeKitDevice.PLUGIN_NAME + ' v' + version + ' (HAP v' + HAP.HAPLibraryVersion() + ') (Node v' + process.versions.node + ')');

// Check to see if a configuration file was passed into use and validate if present
let configurationFile = path.resolve(__dirname, CONFIGURATION_FILE);
let argFile = process.argv[2];
if (typeof argFile === 'string') {
  configurationFile = path.isAbsolute(argFile) ? argFile : path.resolve(process.cwd(), argFile);
}

if (fs.existsSync(configurationFile) === false) {
  // Configuration file, either by default name or specified on commandline is missing
  log.error('Specified configuration "%s" cannot be found', configurationFile);
  process.exit(1);
}

// Have a configuration file, now load the configuration options
let config = loadConfiguration(configurationFile);
if (config === undefined) {
  log.info('Configuration file contains invalid JSON options');
  process.exit(1);
}

log.info('Loaded configuration from "%s"', configurationFile);

// Enable debugging if configured
if (config?.options?.debug === true) {
  Logger.setDebugEnabled();
  log.warn('Debugging has been enabled');
}

// Create the main irrigation system accessory
let deviceData = {
  hkPairingCode: config.options.hkPairingCode,
  hkUsername: config.hkUsername,
  serialNumber: config.serialNumber,
  softwareVersion: version,
  manufacturer: 'n0rt0nthec4t',
  description: 'Irrigation System',
  model: 'Irrigation System',
  power: config.power === true && config.pauseTimeout === 0,
  pauseTimeout: config.pauseTimeout,
  tanks: config.tanks,
  zones: config.zones,
  eveHistory: config.options.eveHistory,
  elevation: config.options.elevation,
  latitude: config.options.latitude,
  longitude: config.options.longitude,
  leakSensor: config.options.leakSensor,
  waterLeakAlert: config.options.waterLeakAlert,
  sensorFlowPin: config.options.sensorFlowPin,
  flowRate: config.options.flowRate,
  maxRuntime: config.options.maxRuntime,
  maxRunningZones: 1, // One zone at a time running only
  usonicBinary: config.options.usonicBinary,
  powerSwitch: config.options.powerSwitch,
  programs: config.programs,
};

let tempDevice = new IrrigationSystem(undefined, HAP, log, deviceData);
let accessory = await tempDevice.add('Irrigation System', HAP.Categories.SPRINKLER, true);

// Start HomeKit Web UI if configured to do so
let ui = undefined;
if (config.options.webUIPort > 0) {
  ui = new HomeKitUI({
    name: 'Irrigation System',
    version,
    port: config.options.webUIPort,
    configFile: configurationFile,
    schemaFile: CONFIG_SCHEMA_FILE,
    accessory,
    hap: HAP,
    log,
    pages: [
      {
        id: 'dashboard',
        title: 'Dashboard',
        svg: '<svg viewBox="0 0 24 24"><path d="M4 13h6V4H4z"/><path d="M14 20h6V4h-6z"/><path d="M4 20h6v-3H4z"/></svg>',
        refreshInterval: 1000,
      },
      {
        id: 'zones',
        title: 'Zones',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></svg>',
        schemaPath: 'zones',
      },
      {
        id: 'tanks',
        title: 'Tanks',
        svg: '<svg viewBox="0 0 24 24"><path d="M12 3C12 3 6 10 6 14a6 6 0 0 0 12 0c0-4-6-11-6-11z"/></svg>',
        schemaPath: 'tanks',
      },
      {
        id: 'options',
        title: 'Options',
        icon: 'settings',
        schemaPath: 'options',
      },
    ],
    onSaveConfig: async (savedConfig) => {
      fs.writeFileSync(configurationFile, JSON.stringify(savedConfig, null, 2) + '\n');

      let newConfig = loadConfiguration(configurationFile);

      // Tanks changed
      if (JSON.stringify(config.tanks) !== JSON.stringify(newConfig.tanks)) {
        await HomeKitDevice.message(accessory.UUID, HomeKitDevice.UPDATE, {
          tanks: newConfig.tanks,
        });
      }

      // Zones changed
      if (JSON.stringify(config.zones) !== JSON.stringify(newConfig.zones)) {
        await HomeKitDevice.message(accessory.UUID, HomeKitDevice.UPDATE, {
          zones: newConfig.zones,
        });
      }

      // Options changed
      if (JSON.stringify(config.options) !== JSON.stringify(newConfig.options)) {
        await HomeKitDevice.message(accessory.UUID, HomeKitDevice.UPDATE, {
          eveHistory: newConfig.options.eveHistory,
          elevation: newConfig.options.elevation,
          latitude: newConfig.options.latitude,
          longitude: newConfig.options.longitude,
          leakSensor: newConfig.options.leakSensor,
          waterLeakAlert: newConfig.options.waterLeakAlert,
          sensorFlowPin: newConfig.options.sensorFlowPin,
          flowRate: newConfig.options.flowRate,
          maxRuntime: newConfig.options.maxRuntime,
          powerSwitch: newConfig.options.powerSwitch,
        });
      }

      // Debug changed
      if (config.options.debug !== newConfig.options.debug) {
        if (newConfig.options.debug === true) {
          Logger.setDebugEnabled(true);
          log.warn('Debugging has been enabled');
        } else {
          Logger.setDebugEnabled(false);
          log.warn('Debugging has been disabled');
        }
      }

      config = newConfig;
    },
    onRestart: async () => {
      await shutdown('restart', 1);
    },
    onGetPage: async (id) => {
      if (id === 'dashboard') {
        // Return has html and css for dashboard page. We'll get this from the device which can provide dynamic data for display
        return tempDevice.getDashboard();
      }

      return {};
    },
    onAction: async (action, data, page) => {
      if (page === 'dashboard' && action === 'power') {
        // Action to turn system power on/off virtually
        tempDevice.setPower(data?.power === true);
      }

      if (page === 'dashboard' && action === 'zone') {
        // Action to turn on/off a zone
        let zone = config.zones.find((item) => item.uuid === data.uuid);

        if (zone !== undefined) {
          tempDevice.setZoneActive(zone, data.active === true);
        }
      }
    },
  });

  await ui.start();
}

// Setup message listener for set calls from the irrigation system
// Allows us to set and save back to configuration file
tempDevice.message(HomeKitDevice.SET, (values = {}) => {
  if (values?.zone !== undefined && values?.zone?.uuid !== undefined) {
    // Setting a zone's details. We'll use the enclosed uuid to match into our configuration file
    // We'll also only update details if present
    config.zones
      .filter((zone) => zone.uuid === values.zone.uuid)
      .forEach((zone) => {
        Object.entries(values.zone).forEach(([key, value]) => {
          if (zone?.[key] !== undefined) {
            zone[key] = value;
          }
        });
      });
  }

  if (typeof values?.options === 'object' && values.options !== null && Array.isArray(values.options) === false) {
    // Setting an 'option'
    // We'll also only update details if present
    Object.entries(values.options).forEach(([key, value]) => {
      if (config?.options?.[key] !== undefined) {
        config.options[key] = value;
      }
    });
  }

  if (typeof values?.power === 'boolean') {
    // Setting 'power' status
    config.power = values.power;
  }

  if (Number.isFinite(Number(values?.pauseTimeout)) === true) {
    // Setting 'pause timeout' status
    config.pauseTimeout = Number(values.pauseTimeout);
  }

  if (values?.programs !== undefined) {
    // Setting 'program/schedules'
    config.programs = values.programs;
  }

  // Write config backout!!
  fs.writeFileSync(configurationFile, JSON.stringify(config, null, 2) + '\n');
  log.debug?.('Configuration updated');
});

// Handle process shutdown
let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown === true) {
    return;
  }

  shuttingDown = true;

  log.warn('Received %s, shutting down gracefully...', signal);

  await HomeKitDevice.shutdown();

  if (ui !== undefined) {
    ui.stop().catch(() => {
      // Empty
    });
  }

  process.exit(exitCode);
}

// Register process signal handlers for graceful shutdown
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.once(signal, () => {
    shutdown(signal, 0);
  });
});
