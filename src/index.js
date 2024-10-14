// HAP-NodeJS Irrigation accessory
//
// Resources:
// https://github.com/sfeakes/SprinklerD
// https://github.com/geoffreypetri/water-flow-sensor
//
// note:
// /boot/config.txt needs "dtoverlay=gpio-no-irq"
//
//
// todo
// - detect valve current usage and switch valves if too much drawn in AMPs vs power supply
// - Scheduling via Eve Home (Aqua)
// - Leverage Apple WeatherKit API for weather data
//
// Code version 10/10/2024
// Mark Hulskamp
'use strict';

// Define HAP-NodeJS module requirements
import HAP from 'hap-nodejs';

// Define nodejs module requirements
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

// Import our modules
import IrrigationSystem from './system.js';

import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'irrigationsystem';
HomeKitDevice.PLATFORM_NAME = 'IrrigationSystem';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

import Logger from './logger.js';
const log = Logger.withPrefix(HomeKitDevice.PLATFORM_NAME);

// Import the package.json file to get the version number
const { version } = createRequire(import.meta.url)('../package.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const ACCESSORYPINCODE = '031-45-154'; // Default HomeKit pairing code
const CONFIGURATIONFILE = 'IrrigationSystem_config.json'; // Default configuration file name

const eventEmitter = new EventEmitter();

// General helper functions which don't need to be part of an object class
function loadConfiguration(filename) {
  if (typeof filename !== 'string' || filename === '' || fs.existsSync(filename) === false) {
    return;
  }

  let config = undefined;

  try {
    let loadedConfig = JSON.parse(fs.readFileSync(filename));

    config = {
      power: false,
      pauseTimeout: 0,
      serialNumber: crc32(crypto.randomUUID().toUpperCase()).toString(),
      hkPairingCode: ACCESSORYPINCODE,
      hkUsername: crypto
        .randomBytes(6)
        .toString('hex')
        .toUpperCase()
        .split(/(..)/)
        .filter((s) => s)
        .join(':'),
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
        debug: false,
      },
      tanks: [],
      zones: [],
      programs: {
        enabled: false,
        schedules: [],
      },
    };

    Object.entries(loadedConfig).forEach(([key, value]) => {
      if (key === 'power') {
        config.power = (typeof value === 'string' && value.toUpperCase() === 'ON') || (typeof value === 'boolean' && value === true);
      }
      if (key === 'pauseTimeout') {
        config.pauseTimeout = isNaN(value) === false && Number(value) > 0 ? Number(value) : 0;
      }
      if (key === 'serialNumber' && typeof value === 'string' && value !== '') {
        config.serialNumber = value.trim();
      }
      if (
        (key === 'hkPairingCode' && new RegExp(/^([0-9]{3}-[0-9]{2}-[0-9]{3})$/).test(value) === true) ||
        new RegExp(/^([0-9]{4}-[0-9]{4})$/).test(value) === true
      ) {
        config.hkPairingCode = value;
      }
      if (key === 'hkUsername' && new RegExp(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/).test(value) === true) {
        config.hkUsername = value;
      }
      if (key === 'options' && Array.isArray(value) === false && typeof value === 'object') {
        config.options.leakSensor = value?.leakSensor === true;
        config.options.waterLeakAlert = value?.waterLeakAlert === true;
        config.options.sensorFlowPin =
          isNaN(value?.sensorFlowPin) === false && Number(value.sensorFlowPin) >= 0 && Number(value.sensorFlowPin) <= 26
            ? value.sensorFlowPin
            : undefined;
        config.options.flowRate = isNaN(value?.flowRate) === false ? Number(value.flowRate) : 0.0;
        config.options.maxRuntime = isNaN(value?.maxRuntime) === false ? Number(value.maxRuntime) : 7200;
        config.options.latitude =
          isNaN(value?.latitude) === false && Number(value.latitude) >= -90 && Number(value.latitude) <= 90 ? Number(value.latitude) : 0.0;
        config.options.longitude =
          isNaN(value?.longitude) === false && Number(value.longitude) >= -180 && Number(value.longitude) <= 180
            ? Number(value.longitude)
            : 0.0;
        config.options.elevation = isNaN(value?.elevation) === false ? Number(value.elevation) : 0;
        config.options.eveHistory = value?.eveHistory === true;
        config.options.powerSwitch = value?.powerSwitch === true;
        config.options.debug = value?.debug === true;
      }
      if (key === 'tanks' && Array.isArray(value) === true) {
        // Validate tanks section
        let unnamedCount = 1;
        value.forEach((tank) => {
          let tempTank = {
            uuid: tank?.uuid !== undefined && tank.uuid !== '' ? tank.uuid.trim() : crypto.randomUUID(),
            name: tank?.name !== undefined && tank.name !== '' ? makeHomeKitName(tank.name.trim()) : 'Tank ' + unnamedCount++,
            enabled: tank?.enabled === true,
            capacity: isNaN(tank?.capacity) === false && Number(tank.capacity) > 0 ? Number(tank.capacity) : 0,
            sensorTrigPin:
              isNaN(tank?.sensorTrigPin) === false &&
              isNaN(tank?.sensorEchoPin) === false &&
              Number(tank.sensorTrigPin) >= 0 &&
              Number(tank.sensorTrigPin) <= 26
                ? Number(tank.sensorTrigPin)
                : undefined,
            sensorEchoPin:
              isNaN(tank?.sensorEchoPin) === false &&
              isNaN(tank?.sensorTrigPin) === false &&
              Number(tank.sensorEchoPin) >= 0 &&
              Number(tank.sensorEchoPin) <= 26
                ? Number(tank.sensorEchoPin)
                : undefined,
            sensorHeight: isNaN(tank?.sensorHeight) === false && Number(tank.sensorHeight) > 0 ? Number(tank.sensorHeight) : 0,
            minimumLevel: isNaN(tank?.minimumLevel) === false && Number(tank.minimumLevel) > 0 ? Number(tank.minimumLevel) : 0,
          };

          if (tempTank.minimumLevel > tempTank.sensorHeight) {
            tempTank.minimumLevel = tempTank.sensorHeight;
          }

          config.tanks.push(tempTank);
        });
      }

      if (key === 'zones' && Array.isArray(value) === true) {
        // validate zones section
        let unnamedCount = 1;
        value.forEach((zone) => {
          let tempZone = {
            uuid: zone?.uuid !== undefined && zone.uuid !== '' ? zone.uuid.trim() : crypto.randomUUID(),
            name: zone?.name !== undefined && zone.zone !== '' ? makeHomeKitName(zone.name.trim()) : 'Zone ' + unnamedCount++,
            enabled: zone?.enabled === true,
            runtime: isNaN(zone?.runtime) === false ? Number(zone.runtime) : 300, // 5mins by default
            relayPin: isNaN(zone.relayPin) === false ? Number(zone.relayPin) : undefined,
          };

          if (tempZone.relayPin === undefined && Array.isArray(zone.relayPin) === true) {
            // Since multiple relay pins, we'll assume a relaypin group. validate it though
            tempZone.relayPin = [];
            zone.relayPin.forEach((pin) => {
              if (isNaN(pin) === false) {
                tempZone.relayPin.push(Number(pin));
              }
            });
          }

          if (isNaN(loadedConfig?.options?.maxRuntime) === false && tempZone.runtime > Number(loadedConfig.options.maxRuntime)) {
            tempZone.runtime = loadedConfig.options.maxRuntime;
          }

          config.zones.push(tempZone);
        });
      }

      // Validate programs
      if (key === 'programs' && typeof value === 'object' && Array.isArray(value) === false) {
        config.programs.enabled = value?.enabled === true;
        config.programs.schedules = Array.isArray(value?.schedules) === true ? value.schedules : [];
      }
    });

    // Fix up power state after processing config. If we have a paused timeout set, system will be off
    config.power = config.power === true && config.pauseTimeout === 0;

    // Write config backout!!
    fs.writeFileSync(filename, JSON.stringify(config, null, 3));

    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Empty
  }

  return config;
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
  for (var index = 0; index < valueToHash.length; index++) {
    crc32 = (crc32HashTable[(crc32 ^ valueToHash[index]) & 0xff] ^ (crc32 >>> 8)) & 0xffffffff;
  }
  crc32 ^= 0xffffffff;
  return crc32 >>> 0; // return crc32
}

function makeHomeKitName(nameToMakeValid) {
  // Strip invalid characters to meet HomeKit naming requirements
  // Ensure only letters or numbers are at the beginning AND/OR end of string
  // Matches against uni-code characters
  return typeof nameToMakeValid === 'string'
    ? nameToMakeValid
        .replace(/[^\p{L}\p{N}\p{Z}\u2019.,-]/gu, '')
        .replace(/^[^\p{L}\p{N}]*/gu, '')
        .replace(/[^\p{L}\p{N}]+$/gu, '')
    : nameToMakeValid;
}

// Startup code
log.success(HomeKitDevice.PLUGIN_NAME + ' v' + version + ' (HAP v' + HAP.HAPLibraryVersion() + ') (Node v' + process.versions.node + ')');

// Check to see if a configuration file was passed into use and validate if present
let configurationFile = path.resolve(__dirname + '/' + CONFIGURATIONFILE);
if (process.argv.slice(2).length === 1) {
  // We only support/process one argument
  configurationFile = process.argv.slice(2)[0]; // Extract the file name from the argument passed in
  if (configurationFile.indexOf('/') === -1) {
    configurationFile = path.resolve(__dirname + '/' + configurationFile);
  }
}
if (fs.existsSync(configurationFile) === false) {
  // Configuration file, either by default name or specified on commandline is missing
  log.error('Specified configuration "%s" cannot be found', configurationFile);
  log.error('Exiting.');
  process.exit(1);
}

// Have a configuration file, now load the configuration options
let config = loadConfiguration(configurationFile);
if (config === undefined) {
  log.info('Configuration file contains invalid JSON options');
  log.info('Exiting.');
  process.exit(1);
}

log.info('Loaded configuration from "%s"', configurationFile);

// Enable debugging if configured
if (config?.options?.debug === true) {
  Logger.setDebugEnabled();
  log.warn('Debugging has been enabled');
}

// Create the main irrigation system accessory
let deviceData = {};
deviceData.hkPairingCode = config.hkPairingCode;
deviceData.hkUsername = config.hkUsername;
deviceData.serialNumber = config.serialNumber;
deviceData.softwareVersion = version;
deviceData.manufacturer = 'n0rt0nthec4t';
deviceData.description = 'Irrigation System';
deviceData.model = 'Irrigation System';
deviceData.power = config.power === true && config.pauseTimeout === 0;
deviceData.pauseTimeout = config.pauseTimeout;
deviceData.tanks = config.tanks;
deviceData.zones = config.zones;
deviceData.eveHistory = config.options.eveHistory;
deviceData.elevation = config.options.elevation;
deviceData.latitude = config.options.latitude;
deviceData.longitude = config.options.longitude;
deviceData.leakSensor = config.options.leakSensor;
deviceData.waterLeakAlert = config.options.waterLeakAlert;
deviceData.sensorFlowPin = config.options.sensorFlowPin;
deviceData.flowRate = config.options.flowRate;
deviceData.maxRuntime = config.options.maxRuntime;
deviceData.maxRunningZones = 1; // One zone at a time runnning only
deviceData.powerSwitch = config.options.powerSwitch;
deviceData.programs = config.programs;
let tempDevice = new IrrigationSystem(undefined, HAP, log, eventEmitter, deviceData);
tempDevice.add('Irrigation System', HAP.Categories.SPRINKLER, true);

// Setup event listenersfor set calls from the irrigation system
// Allows us to set and save back to configuration file
eventEmitter.addListener(HomeKitDevice.SET, (uuid, values) => {
  if (uuid !== undefined && typeof values === 'object') {
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
  }

  if (values?.options !== undefined) {
    // Setting a 'option'
    // We'll also only update details if present
    Object.entries(values).forEach(([key, value]) => {
      if (config?.options?.[key] !== undefined) {
        config.options[key] = value;
      }
    });
  }

  if (values?.power !== undefined && typeof values.power === 'boolean') {
    // Setting 'power' status
    config.power = values.power;
  }

  if (values?.pauseTimeout !== undefined && isNaN(values?.pauseTimeout) === false) {
    // Setting 'pause timeout' status
    config.pauseTimeout = Number(values.pauseTimeout);
  }

  if (values?.programs !== undefined) {
    // Setting 'program/schules'
    config.programs = values.programs;
  }

  // Write config backout!!
  fs.writeFileSync(configurationFile, JSON.stringify(config, null, 3));
});
