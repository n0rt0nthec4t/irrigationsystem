// HAP-NodeJS Irrigation accessory
//
// Resources:
// https://github.com/simont77/fakegato-history
// https://github.com/sfeakes/SprinklerD
// https://github.com/geoffreypetri/water-flow-sensor
//
// note:
// /boot/config.txt needs "dtoverlay=gpio-no-irq"
//
// 
// todo
// -- detect valve current usage and switch valves if too much drawn in AMPs vs power supply
// -- Scheduling via Eve Home (Aqua)
// -- Leverage Apple WeatherKIT API for weathe data
//
// done
// -- Group of zones, to make a "virtual" zone with combined runtime
// -- "smoothing" of water level data
// -- history recording - testing of own solution
// -- use system WIFI mac addr as AccessoryUsername (Override option also in config)
// -- low tank level distance (ie: minimun water level)
// -- virtual power switch
// -- save changes to zone names
// -- restructured code
// -- save configuration changes in off-line file for when system restarted
// -- master valve support and configurable per zone
// -- hardware rain sensor input
// -- flow meter - measure water usage & leaking
// -- support more than one tank - agregate water levels between then all as one percentage
// -- Can use hey siri to turn off/on system or configure to have a vitual power switch
// -- updated to use npm version of hap-nodejs directory structure (11/4/2020) 
// -- Master valve only closes when all zones have finished being active
// -- removed rain sensor code and replaced with a "virtual" weather station
// -- converted to accessory factory due to new hosting two distinct accessories
// -- Preparation to use HAP-NodeJS as a library, rather than accessory factory as is now. Will allow for depreciation of HAP-NodeJS's Core.js
// -- rewrite to use "common" HomeKit device class
// -- some functionality drop ie: mastervalve, rainsensor, 
//
// bugs
// -- running as a service at system startup, MAC address isnt returned when no IP assigned to wifi. Maybe just loop until assigned?. 
//    26/4/2019 -- Changed service startup to wait for network. Monitor
// -- hey siri to turn off/on system doesn't work in iOS 15??
// -- iOS/iPadOS/macOS recent controls don't show in Home app <- seem fixed in latest versions ie: 16.x
//
// Version 22/4/2024
// Mark Hulskamp

"use strict";

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define nodejs module requirements
var fs = require("fs");
var os = require('os');
var util = require("util");
var EventEmitter = require("events");
var {spawn} = require("child_process");

// Define external lbrary requirements
var GPIO = require("rpio");

// Define our external module requirements
var HomeKitHistory = require("./HomeKitHistory");
var HomeKitDevice = require("./HomeKitDevice");
HomeKitDevice.HOMEKITHISTORY = HomeKitHistory;                  // History module for the device
const ACCESSORYNAME = "n0rt0nthec4t";                           // Used for manufacturer name of HomeKit device
const ACCESSORYPINCODE = "031-45-154";                          // HomeKit pairing code


// Irrigation System
HAP.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE = 2;   // Fix until changed in hap-nodejs based code

const WATERLEAKTIMEOUT = (10 * 1000);                           // Milliseconds after a water valve is closed before we can report on any water leak
const FLOWDATABUFFER = (30 * 1000);                             // Milliseconds of water flow data to store. Used to determine constant leak

class IrrigationSystem extends HomeKitDevice {
    constructor(initialDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, HAP.MDNSAdvertiser.CIAO, initialDeviceData, globalEventEmitter);

        this.irrigationService = null;      // HomeKit service for this irrigation system
        this.leakSensorService = null;      // HomeKit service for a "leak" sensor
        this.zones = [];                    // Array of zones we've created
        this.tanks = [];                    // Array of water tanks connected
        this.lastValveClose = 0;            // Last time a valve was closed
        this.flowData = [];                 // Water flow readings buffer
        this.flowPulseCounter = 0;          // Flow sensor pulse counter
        this.flowTimer = null;
        this.activeCheck = [];
        this.activeCheckTimer = null;
        this.leakDetected = false;          // No Water leak detected yet
    }

    // Class functions
    addHomeKitServices(serviceName) {
        // Add this Irrigation system to the "master" accessory and set properties
        this.irrigationService = this.HomeKitAccessory.addService(HAP.Service.IrrigationSystem, "Irrigation System", 1);
        this.HomeKitAccessory.setPrimaryService(this.irrigationService);

        // Create flow/leak sensor if configured
        if (this.deviceData.system.FlowSensorPin != 0) {
            // Initialise the GPIO output PINs for this valve
            GPIO.open(this.deviceData.system.FlowSensorPin, GPIO.INPUT, GPIO.PULL_UP);
            GPIO.poll(this.deviceData.system.FlowSensorPin, () => { this.flowPulseCounter++ }, GPIO.POLL_HIGH);   // Start the pulse counter

            setInterval(() => {
                // We've got the number of pulses over a set period of time, so calculate flow rate and volume used in this period
                if (this.flowTimer != null) {
                    // Q (L/min) =  (F (Hz) / 1000) * factor (L/min)
                    // V (L) = Q (L/Min) * (duration (min) )
                    var intervalDuration = (Date.now() - this.flowTimer);
                    var flowRate = (this.flowPulseCounter / (intervalDuration / 1000)) * this.deviceData.system.FlowSensorRate;
                    var flowVolume = flowRate * (intervalDuration / 60000);

                    // Determine if flow rate calculated is "within" bounds. We use this to filter out extremes and random responses
                    
                    // Send out an event with current water flow data
                    this.eventEmitter.emit(FLOWEVENT, {"time" : Date.now(), "rate": flowRate, "volume": flowVolume});

                    // Debugging
                    if (flowRate > 40) {
                        console.log("timer", this.flowTimer);
                        console.log("duration", intervalDuration);
                        console.log("pulses", this.flowPulseCounter);
                        console.log("factor", this.deviceData.system.FlowSensorRate);
                        console.log("rate", flowRate);
                    }
                }

                this.flowTimer = Date.now();  // Update process time
                this.flowPulseCounter = 0;  // Reset pulse counter
            }, 1000);  // Check the water flow every 1 second, which is 1Hz

            // Create the HomeKit service for the leak sensor
            this.leakSensorService = this.HomeKitAccessory.addService(HAP.Service.LeakSensor, "Water Leak", 1);
            this.leakSensorService.updateCharacteristic(HAP.Characteristic.LeakDetected, HAP.Characteristic.LeakDetected.LEAK_NOT_DETECTED);    // No leak by default
            
            outputLogging(ACCESSORYNAME, false, "Added water leak sensor on GPIO pin '%s'", this.deviceData.system.FlowSensorPin, (this.deviceData.system.WaterLeakAlert == true ? "with HomeKit alerting" : ""));
        }

        // Add in any defined water tanks
        if (this.deviceData.tanks.length > 0) {
            this.deviceData.tanks.forEach(tank => {
                if (tank.Enabled == true) {
                    if (this.irrigationService.testCharacteristic(HAP.Characteristic.WaterLevel) == false) {
                        // We haven't added the water level characteristic as yet and this is the first enabled tank we have
                        this.irrigationService.addCharacteristic(HAP.Characteristic.WaterLevel);
                    }
                    this.tanks.push(new WaterTank(tank.TankHeight, tank.MinimumLevel, tank.SensorTrig, tank.SensorEcho, this.eventEmitter));
                    outputLogging(ACCESSORYNAME, false, "Added watertank with sensor on GPIO pins '%s,%s'", tank.SensorTrig, tank.SensorEcho);
                }
            });
        }

        // Setup any defined "physical" and/or "virtual" irrigation zones
        this.#buildIrrigationZones();

        // Setup linkage to EveHome app if configured todo so
        if (this.deviceData.eveapp.Enabled == true && this.HomeKitHistory != null) {
            this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.irrigationService, {GetCommand: this.#EveHomeGetCommand.bind(this),
                                                                                                SetCommand: this.#EveHomeSetCommand.bind(this),
                                                                                                debug: true
                                                                                            });
        }

        // Setup event listeners for various events we'll want to process
        this.eventEmitter.addListener(WATERTANKLEVEL, (waterTankLevelData) => {this.messageHomeKitServices(WATERTANKLEVEL, waterTankLevelData)});
        this.eventEmitter.addListener(VALVEEVENT, (valveData) => {this.messageHomeKitServices(VALVEEVENT, valveData)});
        this.eventEmitter.addListener(FLOWEVENT, (flowData) => {this.messageHomeKitServices(FLOWEVENT, flowData)});

        // Setup HomeKit callbacks
        this.irrigationService.getCharacteristic(HAP.Characteristic.Active).on("set", (value, callback) => {this.#processActiveCharacteristic(this, value, callback, "system");});
        this.irrigationService.getCharacteristic(HAP.Characteristic.Active).on("get", (callback) => {this.getPower(callback); });

        // Setup event timer for various functions
        setInterval(() => {
            // Monitoring pausing of system and un-pause if needed
            if (this.deviceData.system.PauseTimeout != 0 && (Math.floor(Date.now() / 1000) >= this.deviceData.system.PauseTimeout)) {
                // Pause timeout expired, so turn system back on
                this.setPower(true, null);
                outputLogging(ACCESSORYNAME, false, "Watering has resumed after being paused");
            }
        }, 5000);    // Every 5 seconds. maybe every second??

        outputLogging(ACCESSORYNAME, false, "Setup Irrigation System '%s'", serviceName);
    }

    setPower(value, callback) {
        // Turns the irrigation system "virtually" on or off
        this.irrigationService.updateCharacteristic(HAP.Characteristic.InUse, HAP.Characteristic.InUse.NOT_IN_USE); // Not in use until we start a valve??

        if (value == "off" || value == false || value == HAP.Characteristic.Active.INACTIVE) {
            // For any valves that are opened, finish them running gracefully
            this.zones.forEach((zone) => {
                if (zone.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.ACTIVE) {
                    this.setZoneActive(zone.service, HAP.Characteristic.Active.INACTIVE, null);
                }
            });

            this.irrigationService.updateCharacteristic(HAP.Characteristic.ProgramMode, HAP.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);
            this.irrigationService.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.INACTIVE);
    
            this.deviceData.system.PowerState = "off";
            this.deviceData.system.PauseTimeout = this.deviceData.system.PauseTimeout;
        }

        if (value == "on" || value == true || value == HAP.Characteristic.Active.ACTIVE) {
            this.irrigationService.updateCharacteristic(HAP.Characteristic.ProgramMode, HAP.Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE);
            this.irrigationService.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.ACTIVE);
    
            this.deviceData.system.PowerState = "on";
            this.deviceData.system.PauseTimeout = 0;
        }

        // Save current configuration
        this.set({["system"] : this.deviceData.system});

        outputLogging(ACCESSORYNAME, false, "Irrigation system was turned '%s'", this.deviceData.system.PowerState);

        if (typeof callback === "function") callback();  // do callback if defined
    }

    getPower(callback) {
        if (typeof callback === "function") callback(null, (this.deviceData.system.PowerState == "on" ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE));  // do callback if defined
        return (this.deviceData.system.PowerState == "on" ? true : false)
    }

    setZoneName(context, value, callback) {
        var setName = this.deviceData.zones[context.id].Name; 
        if (value != "") {
            // Work around when HomeKit requests to set zone name as blank. 
            // Seems to happen on initial pairing for irrigation system to HomeKit
            // Unsure why this is happening???
            setName = value;
        }

        console.log("zone id '%s' current name '%s' our set '%s' asked '%s'", context.id, this.deviceData.zones[context.id].Name,  setName, value)

        this.deviceData.zones[context.id].Name = setName;
        context.service.updateCharacteristic(HAP.Characteristic.ConfiguredName, setName);

        // Save updated current configuration
        //this.set({["zones"] : this.deviceData.zones});

        if (typeof callback === "function") callback();  // do callback if defined
    }

    setZoneEnabled(context, value, callback) {
        this.deviceData.zones[context.id].Enabled = (value == HAP.Characteristic.IsConfigured.CONFIGURED) ? true : false;
        context.service.updateCharacteristic(HAP.Characteristic.IsConfigured, value);

        // Save updated current configuration
        this.set({["zones"] : this.deviceData.zones});
        if (typeof callback === "function") callback();  // do callback if defined
    }

    setZoneRuntime(context, value, callback) {
        this.deviceData.zones[context.id].RunTime = value;
        context.service.updateCharacteristic(HAP.Characteristic.SetDuration, value);

        // Save updated current configuration
        this.set({["zones"] : this.deviceData.zones});

        if (typeof callback === "function") callback();  // do callback if defined
    }

    setZoneActive(context, value, callback) {
        if (this.deviceData.zones[context.id].Enabled == true) {
            if (this.deviceData.system.PowerState == "on" && value == HAP.Characteristic.Active.ACTIVE && context.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.INACTIVE) {
                // Request to turn on sprinkler and the irrigation system is active. 
                // We need to see how many sprinkers can be active at once, and ensure we do not exceed that amount
                // If we need to shut a sprinker off to enabled this new one, do so to the one with the shortest runtime remaining
                var activeZoneCount = 0;
                var shortestRunningZone = null;
                this.zones.forEach((zone, index) => {
                    if (zone.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.ACTIVE) {
                        activeZoneCount++;
                        if (shortestRunningZone == null || zone.service.getCharacteristic(Characteristic.RemainingDuration).value < shortestRunningZone.service.getCharacteristic(Characteristic.RemainingDuration).value) {
                            shortestRunningZone = zone;
                        }
                    }
                });
                if (activeZoneCount >= this.deviceData.system.MaxRunningZones && shortestRunningZone != null) {
                    // Since we're using the setValue callback, the actual closing of the valve will happen when this function is re-enter by HomeKit
                    this.setZoneActive(shortestRunningZone, HAP.Characteristic.Active.INACTIVE, null);
                }

                context.totalwater = 0; // No water usage yet for the zone this time
                context.totalduration = 0;  // No run duration for the water amount yet

                if (Array.isArray(context.valves) == true && context.valves.length > 0) {
                    // Whether we have a "physical" or "virtual" zone, we'll open the first valve in the list
                    context.valves[0].openValve();
                }

                context.service.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.ACTIVE);
                context.service.updateCharacteristic(HAP.Characteristic.InUse, HAP.Characteristic.InUse.IN_USE);
                context.service.updateCharacteristic(HAP.Characteristic.RemainingDuration, context.service.getCharacteristic(HAP.Characteristic.SetDuration).value);
                context.timer = setInterval(this.#zoneRunningTimer.bind(this), 100, context, Math.floor(Date.now() / 1000) + context.service.getCharacteristic(HAP.Characteristic.SetDuration).value);
            } else if (this.deviceData.system.PowerState == "off" && value == HAP.Characteristic.Active.ACTIVE && context.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.INACTIVE) {
                // Requested to turn on a valve, but the irrigation system is switched off.. work around need??
                setTimeout(() => {
                    clearInterval(context.timer);   // Cancel any zone running timer
                    context.timer = null;
                    context.service.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.INACTIVE);
                    context.service.updateCharacteristic(HAP.Characteristic.InUse, HAP.Characteristic.InUse.NOT_IN_USE);
                    context.service.updateCharacteristic(HAP.Characteristic.RemainingDuration, 0);
                }, 500);    // Maybe able to reduce this from 500ms???
            } else if (value == HAP.Characteristic.Active.INACTIVE && context.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.ACTIVE) {
                // Turning a valve off
                clearInterval(context.timer);   // Cancel any zone running timer
                context.timer = null;
                context.service.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.INACTIVE);
                context.service.updateCharacteristic(HAP.Characteristic.InUse, HAP.Characteristic.InUse.NOT_IN_USE);
                context.service.updateCharacteristic(HAP.Characteristic.RemainingDuration, 0);

                // Work out which "valve(s)" associated with the zone are opened, and close them
                context.valves.forEach((valve) => {
                    if (valve.isOpened() == true) {
                        valve.closeValve();
                    }
                });
            }
        }

        if (typeof callback === "function") callback();  // do callback if defined
    }

    messageHomeKitServices(messageType, messageData) {
        if (messageType == WATERTANKLEVEL) {
            // Water tank level event, so update total water percentage
            // <---- TODO Need to "smooth" our readings to eliminate random reading
            var totalPercentage = 0;
            this.tanks.forEach((tank) => {
                totalPercentage = totalPercentage + tank.percentage;
            });
            if (totalPercentage > 100) totalPercentage = 100;
            this.irrigationService.updateCharacteristic(HAP.Characteristic.WaterLevel, totalPercentage);
            this.HomeKitHistory.addHistory(HAP.Characteristic.WaterLevel, {time: Math.floor(Date.now() / 1000), level: totalPercentage}, 600);
        }
        if (messageType == FLOWEVENT) {
            // Water flow data, we can use this to determine if have a leaking system
            while (this.flowData.length > 0 && this.flowData[0].time < (messageData.time - FLOWDATABUFFER)) {
                this.flowData.shift();    // Remove the element from the tail of the buffer
            }
            this.flowData.push(messageData);

            if (this.leakSensorService != null) {
                var nonZeroVolume = this.flowData.filter(flow => flow.volume !== 0).length;

                if (this.#numberRunningZones() == 0 && ((nonZeroVolume / this.flowData.length) * 100) > 80) {
                    if (this.lastValveClose == 0 || (this.lastValveClose != 0 && Math.floor(Date.now() / 1000) - this.lastValveClose > WATERLEAKTIMEOUT)) {
                        // No valves are opened and we're calculated that the flow data buffer for the period has logged over 80% water volume figures which are not zero
                        if (this.leakDetected == false) {
                            this.leakDetected = true;   // Suspected water leak
                            if (this.HomeKitHistory != null) {
                                this.HomeKitHistory.addHistory(this.leakSensorService, {time: Math.floor(Date.now() / 1000), status: 1}); // Leak detected
                            }

                            if (this.deviceData.system.WaterLeakAlert == true) {
                                // Trigger HomeKit leak sensor if configured todo so
                                this.leakSensorService.updateCharacteristic(HAP.Characteristic.LeakDetected, HAP.Characteristic.LeakDetected.LEAK_DETECTED);
                            }
                            outputLogging(ACCESSORYNAME, false, "Detected suspected water leak with irrigation system");

                            // Debugging 
                            console.log(this.flowData.filter(flow => flow.volume !== 0), this.flowData.length, nonZeroVolume, this.lastValveClose)
                        }
                    }
                }
                if (this.#numberRunningZones() == 0 && nonZeroVolume == 0) {
                    // We've previously flagged a leak and it now looks like we're no longer reporting one, so clear the leak sensor status
                    if (this.leakDetected == true) {
                        this.leakDetected = false;  // No longer detected water leak
                        if (this.HomeKitHistory != null) {
                            this.HomeKitHistory.addHistory(this.leakSensorService, {time: Math.floor(Date.now() / 1000), status: 0}); // Leak not detected
                        }
                        this.leakSensorService.updateCharacteristic(HAP.Characteristic.LeakDetected, HAP.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
                        outputLogging(ACCESSORYNAME, false, "Suspected water leak no longer detected with irrigation system");
                    }
                }
            }
        }
        if (messageType == VALVEEVENT) {
            var context = this.#getValveContext(messageData.uuid);
            if (messageData.status == ValveStatus.OPENED) {
                if  (context.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.INACTIVE) {
                    if (this.HomeKitHistory != null) {
                        this.HomeKitHistory.addHistory(context.service, {time: messageData.time, status: 1, water: 0, duration: 0}); // Valve opened
                    }
                    outputLogging(ACCESSORYNAME, false, "Zone '%s' was turned 'on'", this.deviceData.zones[context.id].Name);
                }
            }
            if (messageData.status == ValveStatus.CLOSED) {
                this.lastValveClose = messageData.time;
                context.totalwater = context.totalwater + messageData.water;    // Add to running total for water usage
                context.totalduration = context.totalduration + messageData.duration;   // Add to running total for time
                if  (context.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.INACTIVE) {
                    // Since the zone is marked as in-active, we'll assume all valves associated with the zone have finished, so we can log these details
                    if (this.HomeKitHistory != null) {
                        this.HomeKitHistory.addHistory(context.service, {time: messageData.time, status: 0, water: context.totalwater, duration:context.totalduration}); // Valve closed
                    }
                    outputLogging(ACCESSORYNAME, false, "Zone '%s' was turned 'off'. %sL over %sseconds and average rate was %sLPM", this.deviceData.zones[context.id].Name, context.totalwater.toFixed(3), context.totalduration, ((context.totalwater / context.totalduration) * 60).toFixed(3));
                }
            }
        }
    }

    #getValveContext(valveUUID) {
        var context = null;

        this.zones.forEach((zone) => {
            var matchedValve = zone.valves.find( ({ uuid }) => uuid === valveUUID);
            if (typeof matchedValve == "object") {
                context = zone;
            }
        });

        return context;
    }

    #numberRunningZones() {
        var activeZoneCount = 0;

        this.zones.forEach((zone) => {
            if (zone.service.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.ACTIVE) {
                activeZoneCount++;
            }
        });
        return activeZoneCount;
    }

    #numberEnabledZones() {
        var enabledZoneCount = 0;

        this.zones.forEach((zone) => {
            if (zone.service.getCharacteristic(HAP.Characteristic.IsConfigured).value == HAP.Characteristic.IsConfigured.CONFIGURED) {
                enabledZoneCount++;
            }
        });
        return enabledZoneCount;
    }

    #buildIrrigationZones() {
        this.deviceData.zones.forEach((zone, index) => {
           // var tempService = this.HomeKitAccessory.addService(HAP.Service.Valve, zone.Name, (this.zones.length + 1));
            var tempService = this.HomeKitAccessory.addService(HAP.Service.Valve, "", (this.zones.length + 1));
            tempService.addCharacteristic(HAP.Characteristic.IsConfigured);
            tempService.addCharacteristic(HAP.Characteristic.RemainingDuration);
            tempService.addCharacteristic(HAP.Characteristic.SetDuration);
            tempService.addCharacteristic(HAP.Characteristic.ConfiguredName);
            tempService.addCharacteristic(HAP.Characteristic.Identifier);

            // Setup characteristic property ranges 
            tempService.getCharacteristic(HAP.Characteristic.SetDuration).setProps({maxValue: this.deviceData.system.MaxZoneRunTime});
            tempService.getCharacteristic(HAP.Characteristic.RemainingDuration).setProps({maxValue: this.deviceData.system.MaxZoneRunTime});

            tempService.updateCharacteristic(HAP.Characteristic.ValveType, HAP.Characteristic.ValveType.IRRIGATION);
            tempService.updateCharacteristic(HAP.Characteristic.ConfiguredName, zone.Name);
            tempService.updateCharacteristic(HAP.Characteristic.IsConfigured, zone.Enabled == true ? HAP.Characteristic.IsConfigured.CONFIGURED : HAP.Characteristic.IsConfigured.NOT_CONFIGURED);
            tempService.updateCharacteristic(HAP.Characteristic.Active, HAP.Characteristic.Active.INACTIVE);
            tempService.updateCharacteristic(HAP.Characteristic.InUse, HAP.Characteristic.InUse.NOT_IN_USE);
            tempService.updateCharacteristic(HAP.Characteristic.RemainingDuration, 0);
            tempService.updateCharacteristic(HAP.Characteristic.SetDuration, zone.RunTime);
            tempService.updateCharacteristic(HAP.Characteristic.Identifier, (this.zones.length + 1));

            var pushIndex = -1;
            if (typeof zone.RelayPin == "number") {
                // Since single relay pin, this is a "physical" zone
                var tempValve = new Valve(zone.RelayPin, this.eventEmitter);
                pushIndex = this.zones.push({"id" : index, "service" : tempService, "valves": [tempValve], "timer" : null, "totalwater" : 0, "totalduration" : 0}); // Add to our zones list
            }

            if (Array.isArray(zone.RelayPin) == true) {
                // Since replay in is an array, we'll treat this as a "virtual" zone
                var valveArray = [];
                zone.RelayPin.forEach((relayPin) => {
                    valveArray.push(new Valve(relayPin, this.eventEmitter));
                });
                pushIndex = this.zones.push({"id" : index, "service" : tempService, "valves": valveArray, "timer": null, "totalwater" : 0, "totalduration" : 0}); // Add to our zones list
            };

            // Setup HomeKit callbacks
            tempService.getCharacteristic(HAP.Characteristic.Active).on("set", (value, callback) => {this.#processActiveCharacteristic(this.zones[pushIndex - 1], value, callback, "valve")});
            tempService.getCharacteristic(HAP.Characteristic.ConfiguredName).on("set", (value, callback) => {this.setZoneName(this.zones[pushIndex - 1], value, callback)});
            tempService.getCharacteristic(HAP.Characteristic.IsConfigured).on("set", (value, callback) => {this.setZoneEnabled(this.zones[pushIndex - 1], value, callback)});
            tempService.getCharacteristic(HAP.Characteristic.SetDuration).on("set", (value, callback) => {this.setZoneRuntime(this.zones[pushIndex - 1], value, callback)});

            tempService.getCharacteristic(HAP.Characteristic.Active).on("get", (callback) => { callback(null, (this.zones[pushIndex - 1].timer == null ? HAP.Characteristic.Active.INACTIVE : HAP.Characteristic.Active.ACTIVE)); });
            tempService.getCharacteristic(HAP.Characteristic.ConfiguredName).on("get", (callback) => { callback(null, this.deviceData.zones[index].Name); });
            tempService.getCharacteristic(HAP.Characteristic.SetDuration).on("get", (callback) => { callback(null, this.deviceData.zones[index].RunTime); });
            tempService.getCharacteristic(HAP.Characteristic.IsConfigured).on("get", (callback) => { callback(null, this.deviceData.zones[index].Enabled == true ? HAP.Characteristic.IsConfigured.CONFIGURED : HAP.Characteristic.IsConfigured.NOT_CONFIGURED); });

            this.irrigationService.addLinkedService(tempService);   // Link to main irrigation accesssory
            outputLogging(ACCESSORYNAME, false, "Added zone '%s' using GPIO %s '%s'", zone.Name, (zone.RelayPin.length > 1 ? "pins" : "pin"), zone.RelayPin.toString());
        });
    }

    #EveHomeGetCommand(EveHomeGetData) {
        // Pass back extra data for Eve Aqua "get" process command
        // Data will already be an object, our only job is to add/modify to it
   
        EveHomeGetData.firmware = this.deviceData.eveapp.Firmware;
        EveHomeGetData.flowrate = this.deviceData.eveapp.Flowrate;
        EveHomeGetData.programs = this.deviceData.eveapp.Programs.Schedules;
        EveHomeGetData.enableschedule = this.deviceData.eveapp.Programs.Enabled;
        EveHomeGetData.latitude = this.deviceData.eveapp.Latitude;
        EveHomeGetData.longitude = this.deviceData.eveapp.Longitude;
        EveHomeGetData.pause = (this.deviceData.system.PauseTimeout != 0 ? Math.round((this.deviceData.system.PauseTimeout - Math.floor(Date.now() / 1000)) / 86400) : 0);

        return EveHomeGetData;
    }

    #EveHomeSetCommand(EveHomeSetData) {
        if (typeof EveHomeSetData != "object") {
            return;
        }

        console.log(EveHomeSetData)

        if (EveHomeSetData.hasOwnProperty("pause") == true) {
            // EveHome suspension scene triggered from HomeKit
            // 1 day = pause for today
            // 2 day = pause for today and tomorrow
            // get remaining seconds to midnight in our timezone (as date.now() is GMT time), then work out delay             
            this.deviceData.system.PauseTimeout = Math.floor(Math.floor(Date.now() / 1000) + (((8.64e7 - (Date.now() - new Date().getTimezoneOffset() * 6e4) % 8.64e7) / 6e4) * 60) + ((EveHomeSetData.pause - 1) * 86400));    // Timeout date/time in seconds

            outputLogging(ACCESSORYNAME, false, "Watering has been paused for '%s'", (EveHomeSetData.pause == 1 ? "today" : "today and tomorrow"));

            if (this.irrigationService.getCharacteristic(HAP.Characteristic.Active).value == true) {
                this.setPower(false, null); // Turn off irrigation system
            }
        }

        if (EveHomeSetData.hasOwnProperty("flowrate") == true) {
            // Updated flowrate from Eve Home app
            this.deviceData.eveapp.Flowrate = EveHomeSetData.flowrate;
        }

        if (EveHomeSetData.hasOwnProperty("enabled") == true) {
            // Schedules enabled or not
            this.deviceData.eveapp.Programs.Enabled = EveHomeSetData.enabled;
        }

        if (EveHomeSetData.hasOwnProperty("programs") == true) {
            // Watering schedules 
            this.deviceData.eveapp.Programs.Schedules = EveHomeSetData.programs;
        }

        if (EveHomeSetData.hasOwnProperty("childlock") == true) {
        }

        if (EveHomeSetData.hasOwnProperty("latitude") == true) {
            // Latitude information
            this.deviceData.eveapp.Latitude = EveHomeSetData.latitude;
        }
        if (EveHomeSetData.hasOwnProperty("longitude") == true) {
            // Longitude information
            this.deviceData.eveapp.Longitude = EveHomeSetData.longitude;
        }

        // Save any updated configurations for EveHome
        this.set({["eveapp"] : this.deviceData.eveapp});
    }

    #zoneRunningTimer(context, endTime) {
        if (endTime - Math.floor(Date.now() / 1000) >= 0) {
            context.service.updateCharacteristic(HAP.Characteristic.RemainingDuration, endTime - Math.floor(Date.now() / 1000));    // Update HomeKit with remaining duration for zone

            context.valves.forEach((valve, index) => {
                if (valve.isOpened() == true) {
                    // Calculate the remaining time for this valve
                    var zoneEndTime = endTime - ((context.service.getCharacteristic(HAP.Characteristic.SetDuration).value / context.valves.length) * (context.valves.length - index - 1 ));
                    if (Math.floor(Date.now() / 1000) >= zoneEndTime && index < context.valves.length - 1) {
                        // Reached end of the time for this valve, so stop it and start the next in line
                        valve.closeValve();
                        context.valves[index + 1].openValve();  // Open the next valve in the list
                    }
                }
            });
        } else {
            // Zone runtime has finished, so make zone inactive. This does all the valve closing etc
            clearInterval(context.timer);    // Clear timer interval
            context.timer = null;
            this.setZoneActive(context, HAP.Characteristic.Active.INACTIVE, null);
        }
    }

    #processActiveCharacteristic(context, value, callback, type) {
        // workaround for using hey siri to turn on/off system and valves triggering active avents along with system active event
        // Seems we get a system active event and valve events for all configured "enabled" valves when we ask siri to turn on/off
        // the irrigation system. If we just turn on a valve and the system is not active, we get a "system" and "valve" event
        this.activeCheck.push({"context": context, "value": value, "callback": callback, "type": type, "takeaction": true});

        if (this.activeCheckTimer == null) {
            this.activeCheckTimer = setTimeout(() => {
                var systemCount = this.activeCheck.filter(({ type }) => type === "system" || type == "switch").length;
                var valveCount = this.activeCheck.filter(({ type }) => type === "valve").length;

                this.activeCheck.forEach((activeCheck, index) => {
                    // Filter out events we don't want to action
                    if (activeCheck.type == "system" && valveCount == 1) { 
                        // Turned on valve when system was off (inactive)
                        activeCheck.takeaction = false;
                    }
                    if (activeCheck.type == "valve" && (systemCount == 1 && this.#numberEnabledZones() == valveCount)) {
                        // Siri action to turn on/off irrigation system, so make all valve actions as false
                        activeCheck.takeaction = false;
                    }

                    // Process callbacks
                    if ((activeCheck.type == "system" || activeCheck.type == "switch") && activeCheck.takeaction == true) {
                        this.setPower(activeCheck.value, activeCheck.callback);
                    } else if ((activeCheck.type == "system" || activeCheck.type == "switch") && activeCheck.takeaction == false) {
                        activeCheck.callback(null); // process HomeKit callback without taking action
                    }
                    if (activeCheck.type == "valve" && activeCheck.takeaction == true) {
                        this.setZoneActive(activeCheck.context, activeCheck.value, activeCheck.callback);
                    } else if (activeCheck.type == "valve" && activeCheck.takeaction == false) {
                        activeCheck.callback(null); // process HomeKit callback without taking action

                        // Workaround for active state of valves going to "waiting" when we don't want them to straight after the callback to HomeKit
                        setTimeout(() => {
                            activeCheck.context.service.updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
                            activeCheck.context.service.updateCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE);
                            activeCheck.context.service.updateCharacteristic(Characteristic.RemainingDuration, 0);
                        }, 500);   // Maybe able to reduce this from 500ms??? 
                    }
                }); 

                clearTimeout(this.activeCheckTimer);
                this.activeCheck = [];
                this.activeCheckTimer = null;
            }, 500);
        }
    }
}


// Valve class
const VALVEEVENT = "VALVEEVENT";    // Valve event tag
const FLOWEVENT = "FLOWEVENT";      // Water flow event tag
const ValveStatus = {
    OPENED : "opened",
    CLOSED : "closed"
};

class Valve {
    constructor(GPIO_ValvePin, globalEventEmitter) {
        this.GPIO_ValvePin = GPIO_ValvePin;                                     // GPIO pin on which valve can be operated on
        this.valveOpenedTime = 0;                                               // Time valve was opened.. Null means closed
        this.eventEmitter = globalEventEmitter;                                 // Global event emitter
        this.waterAmount = 0;                                                   // Water usage during valve open period
        this.uuid = crc32((this.GPIO_ValvePin + Math.random()).toString());     // Generate a random UUID for this valve object

        // Initialise the GPIO output PINs for this valve
        GPIO.open(this.GPIO_ValvePin, GPIO.OUTPUT, GPIO.LOW);   // Set valve status as closed for default

        // Need to increase the max number of listeners to avoid node throwing an warning
        this.eventEmitter.setMaxListeners(this.eventEmitter.getMaxListeners() + 1);

        this.eventEmitter.addListener(FLOWEVENT, (flowData) => {
            // We'll action any water flow events here. If valve is opened, we'll add the flow figures to the usage amount
            if (this.valveOpenedTime != 0 && typeof flowData == "object" && flowData.hasOwnProperty("volume") == true) {
                this.waterAmount = this.waterAmount + flowData.volume;
            }
        });
    }

    openValve() {
        if (this.GPIO_ValvePin == 0) {
            return;
        }
        
        // Output a high signal on the GPIO, this will trigger the connected relay to open
        GPIO.write(this.GPIO_ValvePin, GPIO.HIGH);
        this.valveOpenedTime = Math.floor(Date.now() / 1000);
        this.waterAmount = 0;

        // Send out an event with the updated valve status
        this.eventEmitter.emit(VALVEEVENT, {"uuid": this.uuid, "pin" : this.GPIO_ValvePin, "status" : ValveStatus.OPENED, "time": this.valveOpenedTime, "water" : 0, "duration" : 0});
    }

    closeValve() {
        if (this.GPIO_ValvePin == 0) {
            return;
        }

        // Output a low signal on the GPIO, this will trigger the connected relay to close
        GPIO.write(this.GPIO_ValvePin, GPIO.LOW);

        // Send out an event with the updated valve status
        this.eventEmitter.emit(VALVEEVENT, {"uuid": this.uuid, "pin" : this.GPIO_ValvePin, "status" : ValveStatus.CLOSED, "time": Math.floor(Date.now() / 1000), "water": this.waterAmount, "duration" : (this.valveOpenedTime != 0 ? Math.floor(Date.now() / 1000) - this.valveOpenedTime : 0)});

        this.waterAmount = 0;   // Reset water usage amount
        this.valveOpenedTime = 0;    // Valve closed, so no open time
    }

    isOpened() {
        return this.valveOpenedTime != 0 ? true : false;
    }

    getWaterUsage() {
        return this.waterAmount;
    }
}


// WaterTank class
const USONICREADINGS = 1;                   // Number of usonic readings made to get a measurement 
const USONICMINRANGE = 200;                 // Minimum range for ultrasonic sensor in mm
const USONICMAXRANGE = 4500;                // maximum range for ultrasonic sensor in mm
const WATERTANKLEVELREFRESH = 60 * 1000;    // Refresh water tank level every 60 seconds
const WATERTANKLEVEL = "WATERTANKLEVEL";    // Water tank level event tag

class WaterTank {
    constructor(tankHeight, minTankLevel, sensorTrigPin, sensorEchoPin, globalEventEmitter) {
        this.tankHeight = tankHeight;                                                                   // Height of watertank in centimeters 
        this.minTankLevel = minTankLevel;                                                               // Minimum usable waterlevel height in centimeters
        this.GPIO_trigPin = sensorTrigPin;                                                              // GPIO pin for "trigger" pin of ultrasonic sensor 
        this.GPIO_echoPin = sensorEchoPin;                                                              // GPIO pin for "echo" pin of ultrasonic sensor 
        this.waterlevel = -1;                                                                           // No water tank level yet
        this.percentage = -1;                                                                           // No percentage full yet
        this.eventEmitter = globalEventEmitter;                                                         // Global event emitter
        this.uuid = crc32((this.GPIO_trigPin + this.GPIO_echoPin + Math.random()).toString());          // Generate a random UUID for this watertank object

        if (this.minTankLevel < 0) this.minTankLevel = 0;
        if (this.minTankLevel > this.tankHeight) this.minTankLevel = this.tankHeight;

        // Perform an inital read of the watertank level
        this.#readWaterLevel();

        // Setup interval to refresh watertank level
        setInterval(this.#readWaterLevel.bind(this), WATERTANKLEVELREFRESH);
    }

    getWaterLevel() {
        return {"uuid": this.uuid, "waterlevel" : this.waterlevel, "percentage" : this.percentage};
    }

    async #readWaterLevel() {
        if (fs.existsSync(process.cwd() + "/usonic_measure") == false || this.GPIO_trigPin == 0 || this.GPIO_echoPin == 0) {
            return;
        }

        // Gets the level of the water tank, averages and calculates percentage full
        var actualDistance = -1;
        var averageDistance = -1;

        for (var index = 0; index < USONICREADINGS; index++) {
            var usonicProcess = spawn(process.cwd() + "/usonic_measure", [this.GPIO_trigPin, this.GPIO_echoPin]);

            usonicProcess.stdout.on("data", (data) => {
                if (data.toString().toUpperCase() == "OUT OF RANGE") {
                    // lets assume if we get an out of range measurement, we're below the minimin workable distance
                    actualDistance = USONICMINRANGE;
                }
                if (data.toString().split(":")[0].toUpperCase() == "DISTANCE") {
                    // we have a distance measurement. formatted as "Distance: xxxx cm"
                    actualDistance = data.toString().split(" ")[1] * 10;  // Convert CM to MM
                    
                    // Baseline measurement
                    if (actualDistance < USONICMINRANGE) actualDistance = USONICMINRANGE;
                    if (actualDistance > USONICMAXRANGE) actualDistance = USONICMAXRANGE;
                    if (actualDistance > this.tankHeight) actualDistance = this.tankHeight;
                }

                // Average readings
                averageDistance = averageDistance + actualDistance;
            });

            await EventEmitter.once(usonicProcess, "exit");  // Wait until childprocess (usonic_measure) has issued exit event
        }

        if (averageDistance != -1 && actualDistance != -1) {
            averageDistance = averageDistance / USONICREADINGS;

            // Adjust the measured height if we have a minimum usable water level in tank, then scale
            // Since the minimum workable range might not be zero, scale the min usonic <> tank height into 0 <> tank height
            this.waterlevel = (this.tankHeight - this.minTankLevel) - scaleValue(averageDistance, USONICMINRANGE, (this.tankHeight - this.minTankLevel), 0, (this.tankHeight - this.minTankLevel));
            this.percentage = ((this.waterlevel / (this.tankHeight - this.minTankLevel)) * 100);
            if (this.percentage < 0) this.percentage = 0;
            if (this.percentage > 100) this.percentage = 100;
    
            // Send out an event with the updated watertank level. This will only be sent if the usonic readings were successful
            this.eventEmitter.emit(WATERTANKLEVEL, {"uuid": this.uuid, "waterlevel" : this.waterlevel, "percentage" : this.percentage});
        }
    }
}


// Configuration class
//
// Handles system configuration file
const CONFIGURATIONFILE = "IrrigationSystem_config.json";           // Default configuration file name, located in current directory

class Configuration {
    constructor(configurationFile, globalEventEmitter) {
        this.loaded = false;                                        // Have we loaded a configuration
        this.configurationFile = configurationFile;                 // Configuration file path/name
        this.eventEmitter = globalEventEmitter;

        this.tanks = [];

        this.system = {};
        this.system.PowerState = "off";
        this.system.PauseTimeout = 0;
        this.system.MaxRunningZones = 1;
        this.system.FlowSensorPin = 0;
        this.system.FlowSensorRate =  0.0;
        this.system.WaterLeakAlert = false;
        this.system.MaxHistory = 4096;
        this.system.MacAddress = this.#getSystemMACAddress();
        this.system.MaxZoneRunTime = 7200; // 120mins or 2hrs max runtime per zone as default
        this.system.SerialNumber = crc32(this.system.MacAddress).toString();   // Default serial number

        this.eveapp = {};
        this.eveapp.Enabled = false;
        this.eveapp.Firmware = 1208;    // Eve Aqua minimum firmware version
        this.eveapp.Flowrate = 18.0;   // Eve Aqua flow rate in L/Min. seems 18 is the default
        this.eveapp.Latitude = 0.0;
        this.eveapp.Longitude = 0.0;
        this.eveapp.Programs = {};
        this.eveapp.Programs.Enabled = false;
        this.eveapp.Programs.Schedules = [];

        this.weather = {};
        this.weather.Enabled = false;
        this.weather.APIKey = "";
        this.weather.Latitude = 0.0;
        this.weather.Longitude = 0.0; 
        this.weather.Elevation = 0; // Elevation is sealevel if not configured

        this.zones = [];

        // Load configuration
        if (this.configurationFile == "" || fs.existsSync(this.configurationFile) == false) {
            return;
        }

        try {
            var config = JSON.parse(fs.readFileSync(this.configurationFile));
            this.loaded = true; // Loaded

            // Validate tanks section
            if (config.hasOwnProperty("tanks") == true && Array.isArray(config.tanks) == true) {
                config.tanks.forEach((tank, index) => {
                    var tempTank = {}
                    tempTank.Name = tank.hasOwnProperty("Name") == true && typeof tank.Name == "string" ? tank.Name.trim() : "Tank " + (index + 1);
                    config.tanks[index].Name = tempTank.Name;  // Write out this value to config as its new
                    tempTank.Enabled = tank.hasOwnProperty("Enabled") == true && typeof tank.Enabled == "boolean" ? tank.Enabled : false;
                    tempTank.TankHeight = tank.hasOwnProperty("TankHeight") == true && typeof tank.TankHeight == "number" ? parseInt(tank.TankHeight) : 0;
                    tempTank.MinimumLevel = tank.hasOwnProperty("MinimumLevel") == true && typeof tank.MinimumLevel == "number" ? parseInt(tank.MinimumLevel) : 0;
                    tempTank.SensorTrig = tank.hasOwnProperty("SensorTrig") == true && typeof tank.SensorTrig == "number" ? parseInt(tank.SensorTrig) : 0;
                    tempTank.SensorEcho = tank.hasOwnProperty("SensorEcho") == true  && typeof tank.SensorEcho == "number" ? parseInt(tank.SensorEcho) : 0;
                    if (tempTank.MinimumLevel < 0) tempTank.MinimumLevel = 0;
                    if (tempTank.MinimumLevel > tempTank.TankHeight) tempTank.MinimumLevel = tempTank.TankHeight;
                    this.tanks.push(tempTank);  // Add to our configuration array
                });
            }
            
            // validate system section
            if (config.system.hasOwnProperty("PowerState") == true && typeof config.system.PowerState == "string") {
                if (config.system.PowerState.toUpperCase() == "ON") {
                    this.system.PowerState = "on";
                }
                if (config.system.PowerState.toUpperCase() == "OFF") {
                    this.system.PowerState = "off";
                }
            }
            if (config.system.hasOwnProperty("PauseTimeout") == true && typeof config.system.PauseTimeout == "number") {
                if (this.system.PowerState == "on") {
                    // If system is on, we cant have paused valves
                    this.system.PauseTimeout = 0;
                }
                if (this.system.PowerState == "off") {
                    this.system.PauseTimeout = parseInt(config.system.PauseTimeout);
                }
            }
            if (config.system.hasOwnProperty("MaxRunningZones") == true && typeof config.system.MaxRunningZones == "number") {
                this.system.MaxRunningZones = parseInt(config.system.MaxRunningZones);
            }
            if (config.system.hasOwnProperty("MaxZoneRunTime") == true && typeof config.system.MaxZoneRunTime == "number") {
                this.system.MaxZoneRunTime = parseInt(config.system.MaxZoneRunTime);
            }
            if (config.system.hasOwnProperty("FlowSensorPin") == true && typeof config.system.FlowSensorPin == "number") {
                this.system.FlowSensorPin = parseInt(config.system.FlowSensorPin);
            }
            if (config.system.hasOwnProperty("FlowSensorRate") == true && typeof config.system.FlowSensorRate == "number") {
                this.system.FlowSensorRate = parseFloat(config.system.FlowSensorRate);
            }
            if (config.system.hasOwnProperty("WaterLeakAlert") == true && typeof config.system.WaterLeakAlert == "boolean") {
                this.system.WaterLeakAlert = config.system.WaterLeakAlert;
            }
            if (config.system.hasOwnProperty("MaxHistory") == true && typeof config.system.MaxHistory == "number") {
                this.system.MaxHistory = parseInt(config.system.MaxHistory);
            }
            if (config.system.hasOwnProperty("MacAddress") == true && typeof config.system.MacAddress == "string") {
                // Validate that the mac address is in format of xx:xx:xx:xx:xx:xx
                if (config.system.MacAddress != "" && config.system.MacAddress.trim().match(`^([0-9A-Fa-f]{2}[:]){5}([0-9A-Fa-f]{2})|([0-9a-fA-F]{4}\\.[0-9a-fA-F]{4}\\.[0-9a-fA-F]{4})$`) != null) {
                    this.system.MacAddress = config.system.MacAddress.trim().toUpperCase();
                }
            }
            if (config.system.hasOwnProperty("SerialNumber") == true && typeof config.system.SerialNumber == "string" && config.system.SerialNumber != "") {
                this.system.SerialNumber = config.system.SerialNumber.trim();
            }

            // validate eveapp section - used for integration into EveHome iOS/iPadOS app
            if (config.eveapp.hasOwnProperty("Enabled") == true && typeof config.eveapp.Enabled == "boolean") {
                this.eveapp.Enabled = config.eveapp.Enabled;
            }
            if (config.eveapp.hasOwnProperty("Firmware") == true && typeof config.eveapp.Firmware == "number") {
                this.eveapp.Firmware = parseInt(config.eveapp.Firmware);
            }
            if (config.eveapp.hasOwnProperty("Flowrate") == true && typeof config.eveapp.Flowrate == "number") {
                this.eveapp.Flowrate = parseFloat(config.eveapp.Flowrate);
            }
            if (config.eveapp.hasOwnProperty("Latitude") == true && typeof config.eveapp.Latitude == "number") {
                if (parseFloat(config.eveapp.Latitude) > -90 && parseFloat(config.eveapp.Latitude) < 90) {
                    this.eveapp.Latitude = parseFloat(config.eveapp.Latitude);
                }
            }
            if (config.eveapp.hasOwnProperty("Longitude") == true && typeof config.eveapp.Longitude == "number") {
                if (parseFloat(config.eveapp.Longitude) > -180 && parseFloat(config.eveapp.Longitude) < 180) {
                    this.eveapp.Longitude = parseFloat(config.eveapp.Longitude);
                }
            }
            if (config.eveapp.Programs.hasOwnProperty("Enabled") == true && typeof config.eveapp.Programs.Enabled  == "boolean") {
                this.eveapp.Programs.Enabled = config.eveapp.Programs.Enabled;
            }
            if (config.eveapp.Programs.hasOwnProperty("Schedules") == true && Array.isArray(config.eveapp.Programs.Schedules) == true) {
                this.eveapp.Programs.Schedules = config.eveapp.Programs.Schedules;
            }
            
            // validate weather section
            if (config.weather.hasOwnProperty("Enabled") == true && typeof config.weather.Enabled == "boolean") {
                this.weather.Enabled = config.weather.Enabled;
            }
            if (config.weather.hasOwnProperty("APIKey") == true && typeof config.weather.APIKey == "string") {
                this.weather.APIKey = config.weather.APIKey.trim();
            }
            if (config.weather.hasOwnProperty("Latitude") == true && typeof config.weather.Latitude == "number") {
                if (parseFloat(config.weather.Latitude) > -90 && parseFloat(config.weather.Latitude) < 90) {
                    this.weather.Latitude = parseFloat(config.weather.Latitude);
                }
            }
            if (config.weather.hasOwnProperty("Longitude") == true && typeof config.weather.Longitude == "number") {
                if (parseFloat(config.weather.Longitude) > -180 && parseFloat(config.weather.Longitude) < 180) {
                    this.weather.Longitude = parseFloat(config.weather.Longitude);
                }
            }
            if (config.weather.hasOwnProperty("Elevation") == true && typeof config.weather.Elevation == "number") {
                this.weather.Elevation = parseInt(config.weather.Elevation);
            }

            // validate zones section
            if (config.hasOwnProperty("zones") == true && Array.isArray(config.zones) == true) {
                config.zones.forEach((zone, index) => {
                    var tempZone = {};
                    tempZone.Name = zone.hasOwnProperty("Name") == true && typeof zone.Name == "string" ? this.#validateHomeKitName(zone.Name.trim()) : "Zone " + (this.zones.length + 1);
                    tempZone.RunTime = zone.hasOwnProperty("RunTime") == true && typeof zone.RunTime == "number" ? parseInt(zone.RunTime) : 300;    // 5mins by default
                    tempZone.Enabled = zone.hasOwnProperty("Enabled") == true && typeof zone.Enabled == "boolean" ? zone.Enabled : false;
                    tempZone.RelayPin = 0;  // No pin by default;

                    if (zone.hasOwnProperty("RelayPin") == true && Array.isArray(zone.RelayPin) == true) {
                        // Since multiple relay pins, we'll assume a relaypin group. validate it though
                        tempZone.RelayPin = [];
                        zone.RelayPin.forEach((pin) => {
                            if (typeof pin == "number") {
                                tempZone.RelayPin.push(parseInt(pin));
                            }
                        });
                    }
                    if (zone.hasOwnProperty("RelayPin") == true && typeof zone.RelayPin == "number") {
                        // Since multiple relay pins, this is a group
                        tempZone.RelayPin = parseInt(zone.RelayPin);
                    }
                    this.zones.push(tempZone);    // Add to our configuration array
                });
            }
        } 
        catch (error) {
        }

        // Setup event processing for set/get properties
        this.eventEmitter.addListener(HomeKitDevice.SET, this.#set.bind(this));
        this.eventEmitter.addListener(HomeKitDevice.GET, this.#get.bind(this));
    }

    async #set(deviceUUID, keyValues) {
        if (typeof deviceUUID != "string" || typeof keyValues != "object" || deviceUUID == "") {
            return;
        }

        Object.entries(keyValues).forEach(([key, value]) => {
            if (this.hasOwnProperty(key) == true && typeof this[key] == typeof value) {
                if (JSON.stringify(this[key]) !== JSON.stringify(value)) {
                    // Configuration values have actually changed, so we can update and save
                    this[key] = value;
                }
            }
        });

        // Build and write configuration back
        var config = {};
        config.tanks = this.tanks;
        config.system = this.system;
        config.eveapp = this.eveapp;
        config.weather = this.weather;
        config.zones = this.zones;
        fs.writeFileSync(this.configurationFile, JSON.stringify(config, null, 3));
    }

    async #get(deviceUUID) {
        // <---- To Implement
    }

    #getSystemMACAddress() {
        // todo - determine active connection, either wifi or ethernet.
        var systemMAC = "00:00:00:00:00:00";
        var networkInterfaces = os.networkInterfaces();
    
        Object.keys(networkInterfaces).forEach(network => {
            networkInterfaces[network].forEach(network => {
                if ((network.family.toUpperCase() == "IPV4" || network.internal == true) && network.mac != "00:00:00:00:00:00") {
                    // found a MAC address
                    systemMAC = network.mac.toUpperCase(); 
                }
            });
        });

        return systemMAC;
    }

    #validateHomeKitName(nameToMakeValid) {
        // Strip invalid characters to meet HomeKit naming requirements
        // Ensure only letters or numbers are at the beginning AND/OR end of string
        return nameToMakeValid.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
    }
}


// General functions
function crc32(valueToHash) {
    var crc32HashTable = [
        0x000000000, 0x077073096, -0x11f19ed4, -0x66f6ae46, 0x0076dc419, 0x0706af48f, -0x169c5acb, -0x619b6a5d, 
        0x00edb8832, 0x079dcb8a4, -0x1f2a16e2, -0x682d2678, 0x009b64c2b, 0x07eb17cbd, -0x1847d2f9, -0x6f40e26f, 
        0x01db71064, 0x06ab020f2, -0xc468eb8, -0x7b41be22, 0x01adad47d, 0x06ddde4eb, -0xb2b4aaf, -0x7c2c7a39, 
        0x0136c9856, 0x0646ba8c0, -0x29d0686, -0x759a3614, 0x014015c4f, 0x063066cd9, -0x5f0c29d, -0x72f7f20b, 
        0x03b6e20c8, 0x04c69105e, -0x2a9fbe1c, -0x5d988e8e, 0x03c03e4d1, 0x04b04d447, -0x2df27a03, -0x5af54a95, 
        0x035b5a8fa, 0x042b2986c, -0x2444362a, -0x534306c0, 0x032d86ce3, 0x045df5c75, -0x2329f231, -0x542ec2a7, 
        0x026d930ac, 0x051de003a, -0x3728ae80, -0x402f9eea, 0x021b4f4b5, 0x056b3c423, -0x30456a67, -0x47425af1, 
        0x02802b89e, 0x05f058808, -0x39f3264e, -0x4ef416dc, 0x02f6f7c87, 0x058684c11, -0x3e9ee255, -0x4999d2c3, 
        0x076dc4190, 0x001db7106, -0x672ddf44, -0x102aefd6, 0x071b18589, 0x006b6b51f, -0x60401b5b, -0x17472bcd, 
        0x07807c9a2, 0x00f00f934, -0x69f65772, -0x1ef167e8, 0x07f6a0dbb, 0x0086d3d2d, -0x6e9b9369, -0x199ca3ff, 
        0x06b6b51f4, 0x01c6c6162, -0x7a9acf28, -0xd9dffb2, 0x06c0695ed, 0x01b01a57b, -0x7df70b3f, -0xaf03ba9, 
        0x065b0d9c6, 0x012b7e950, -0x74414716, -0x3467784, 0x062dd1ddf, 0x015da2d49, -0x732c830d, -0x42bb39b, 
        0x04db26158, 0x03ab551ce, -0x5c43ff8c, -0x2b44cf1e, 0x04adfa541, 0x03dd895d7, -0x5b2e3b93, -0x2c290b05, 
        0x04369e96a, 0x0346ed9fc, -0x529877ba, -0x259f4730, 0x044042d73, 0x033031de5, -0x55f5b3a1, -0x22f28337, 
        0x05005713c, 0x0270241aa, -0x41f4eff0, -0x36f3df7a, 0x05768b525, 0x0206f85b3, -0x46992bf7, -0x319e1b61, 
        0x05edef90e, 0x029d9c998, -0x4f2f67de, -0x3828574c, 0x059b33d17, 0x02eb40d81, -0x4842a3c5, -0x3f459353, 
        -0x12477ce0, -0x65404c4a, 0x003b6e20c, 0x074b1d29a, -0x152ab8c7, -0x622d8851, 0x004db2615, 0x073dc1683, 
        -0x1c9cf4ee, -0x6b9bc47c, 0x00d6d6a3e, 0x07a6a5aa8, -0x1bf130f5, -0x6cf60063, 0x00a00ae27, 0x07d079eb1, 
        -0xff06cbc, -0x78f75c2e, 0x01e01f268, 0x06906c2fe, -0x89da8a3, -0x7f9a9835, 0x0196c3671, 0x06e6b06e7, 
        -0x12be48a, -0x762cd420, 0x010da7a5a, 0x067dd4acc, -0x6462091, -0x71411007, 0x017b7be43, 0x060b08ed5, 
        -0x29295c18, -0x5e2e6c82, 0x038d8c2c4, 0x04fdff252, -0x2e44980f, -0x5943a899, 0x03fb506dd, 0x048b2364b, 
        -0x27f2d426, -0x50f5e4b4, 0x036034af6, 0x041047a60, -0x209f103d, -0x579820ab, 0x0316e8eef, 0x04669be79, 
        -0x349e4c74, -0x43997ce6, 0x0256fd2a0, 0x05268e236, -0x33f3886b, -0x44f4b8fd, 0x0220216b9, 0x05505262f, 
        -0x3a45c442, -0x4d42f4d8, 0x02bb45a92, 0x05cb36a04, -0x3d280059, -0x4a2f30cf, 0x02cd99e8b, 0x05bdeae1d, 
        -0x649b3d50, -0x139c0dda, 0x0756aa39c, 0x0026d930a, -0x63f6f957, -0x14f1c9c1, 0x072076785, 0x005005713, 
        -0x6a40b57e, -0x1d4785ec, 0x07bb12bae, 0x00cb61b38, -0x6d2d7165, -0x1a2a41f3, 0x07cdcefb7, 0x00bdbdf21, 
        -0x792c2d2c, -0xe2b1dbe, 0x068ddb3f8, 0x01fda836e, -0x7e41e933, -0x946d9a5, 0x06fb077e1, 0x018b74777, 
        -0x77f7a51a, -0xf09590, 0x066063bca, 0x011010b5c, -0x709a6101, -0x79d5197, 0x0616bffd3, 0x0166ccf45, 
        -0x5ff51d88, -0x28f22d12, 0x04e048354, 0x03903b3c2, -0x5898d99f, -0x2f9fe909, 0x04969474d, 0x03e6e77db, 
        -0x512e95b6, -0x2629a524, 0x040df0b66, 0x037d83bf0, -0x564351ad, -0x2144613b, 0x047b2cf7f, 0x030b5ffe9, 
        -0x42420de4, -0x35453d76, 0x053b39330, 0x024b4a3a6, -0x452fc9fb, -0x3228f96d, 0x054de5729, 0x023d967bf, 
        -0x4c9985d2, -0x3b9eb548, 0x05d681b02, 0x02a6f2b94, -0x4bf441c9, -0x3cf3715f, 0x05a05df1b, 0x02d02ef8d
    ]
    var crc32 = 0xffffffff; // init crc32 hash;
    valueToHash = Buffer.from(valueToHash);    // convert value into buffer for processing
    for (var index = 0; index < valueToHash.length; index++) {
        crc32 = (crc32HashTable[(crc32 ^ valueToHash[index]) & 0xff] ^ crc32 >>> 8) & 0xffffffff;
    }
    crc32 ^= 0xffffffff;
    return crc32 >>> 0;    // return crc32
}

function scaleValue(value, sourceRangeMin, sourceRangeMax, targetRangeMin, targetRangeMax) {
    if (value < sourceRangeMin) value = sourceRangeMin;
    if (value > sourceRangeMax) value = sourceRangeMax;
    return (value - sourceRangeMin) * (targetRangeMax - targetRangeMin) / (sourceRangeMax - sourceRangeMin) + targetRangeMin;
}

function outputLogging(accessoryName, useConsoleDebug, ...outputMessage) {
    var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
    if (useConsoleDebug == false) {
        console.log(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
    if (useConsoleDebug == true) {
        console.debug(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
}


// Startup code
var eventEmitter = new EventEmitter();  // Need a global event emitter. Will be used for messaging between our classes we create

outputLogging(ACCESSORYNAME, false, "Starting " +  __filename + " using HAP-NodeJS library v" + HAP.HAPLibraryVersion());

// Check to see if a configuration file was passed into use and validate if present
var configurationFile = __dirname + "/" + CONFIGURATIONFILE;
if (process.argv.slice(2).length == 1) {  // We only support/process one argument
    configurationFile = process.argv.slice(2)[0];   // Extract the file name from the argument passed in
    if (configurationFile.indexOf("/") == -1) {
        configurationFile = __dirname + "/" + configurationFile;
    }
}
if (fs.existsSync(configurationFile) == false) {
    // Configuration file, either by default name or specified on commandline is missing
    outputLogging(ACCESSORYNAME, false, "Specified configuration '%s' cannot be found", configurationFile);
    outputLogging(ACCESSORYNAME, false, "Exiting.");
    return;
}

// Have a configuration file, now load the configuration options
outputLogging(ACCESSORYNAME, false, "Configuration will be read from '%s'", configurationFile);
var config = new Configuration(configurationFile, eventEmitter); // Load configuration details from specified file.
if (config.loaded == false) {
    outputLogging(ACCESSORYNAME, false, "Configuration file '%s' contains invalid options", configurationFile);
    outputLogging(ACCESSORYNAME, false, "Exiting.");
    return;
}

// Use the wifi mac address for the HomeKit username, unless overridden
if (config.loaded == true && config.system.MacAddress != "") {
    // Init the GPIO (RPIO) library. This only needs to be done once before using library functions
    GPIO.init({gpiomem: true});
    GPIO.init({mapping: "gpio"});

    // Create the main irrigation system accessory
    var deviceData = {};
    deviceData.uuid = config.system.MacAddress;
    deviceData.mac_address = config.system.MacAddress;
    deviceData.serial_number = config.system.SerialNumber;
    deviceData.software_version = HAP.HAPLibraryVersion();
    deviceData.manufacturer = ACCESSORYNAME;
    deviceData.description = "HomeKit Irrigation System";
    deviceData.location = "";
    deviceData.model = "HomeKit Irrigation System";
    deviceData.tanks = config.tanks;
    deviceData.system = Object.assign({}, config.system);   // Shallow copy
    deviceData.eveapp = Object.assign({}, config.eveapp);   // Shallow copy
    deviceData.zones = config.zones;
    var tempDevice = new IrrigationSystem(deviceData, eventEmitter);
    tempDevice.add("Irrigation System", HAP.Accessory.Categories.SPRINKLER, true);
    tempDevice.setPower(deviceData.system.PowerState == "on" && deviceData.system.PauseTimeout == 0 ? true : false, null);

    // Create virtual weather station if configured 
    if (config.weather.Enabled == true) {

    }

    // cleanup if process stopped.. Mainly used to ensure valves are closed if process stops
    var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
    Object.keys(signals).forEach(function (signal) {
        process.on(signal, () => {
            tempDevice.zones.forEach((zone) => {
                zone.valves.forEach((valve) => {
                    if (valve.isOpened() == true) {
                        valve.closeValve();
                    }
                });
            });

            setTimeout(() => {
                process.exit(128 + signals[signal]);
            }, 2000);
        });
    });
}
