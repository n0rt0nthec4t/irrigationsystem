<span align="center">

# HomeKit Irrigation System

![npm](https://img.shields.io/npm/v/irrigationsystem/latest?label=npm%40latest&color=%234CAF50)
![npm](https://img.shields.io/npm/v/irrigationsystem/beta?label=npm%40beta&color=%23FF9800)
![npm](https://img.shields.io/npm/v/irrigationsystem/alpha?label=npm%40alpha&color=%239E9E9E)

</span>

---

## Overview

Standalone HomeKit-enabled irrigation system built using HAP-NodeJS.

Provides:

- Multi-zone irrigation control
- Water tank level monitoring (ultrasonic)
- Flow-based leak detection
- EveHome history support
- Built-in Web UI (HomeKitUI)
- No Homebridge required

---

## Web UI (HomeKitUI)

This project includes a built-in web interface powered by `HomeKitUI`.

### Features

- Dashboard with live water tank levels
- Irrigation zone configuration
- Tank configuration
- System options
- Live log streaming
- HomeKit pairing management

### Access

http://<device-ip>:8582

Port is configurable via:

options.webUIPort

### Dashboard

Displays:

- Water tank levels (percentage + litres)
- Tank capacity
- Last updated readings

Tank data is updated automatically from sensor events.

### Notes

- Fully self-contained UI (no external frontend)
- Config changes require restart
- Log sources (priority):
  1. journald (systemd)
  2. log file (if configured)
  3. console (fallback)

---

## Parts

Built with readily available off-the-shelf components, housed in a sealed ABS enclosure.

As the system is installed externally, mains wiring (240v → 24v transformer) is isolated in a separate enclosure.

- Raspberry Pi Zero W
- 24v AC transformer (Hunter irrigation)
- LM2596HV AC/DC step-down converter (5v output)
- JSN-SR04T waterproof ultrasonic sensor
- 8-channel solid-state relay board (high-level trigger)
- Water flow sensor (pulse output)
- Waterproof push-on/push-off LED switch
- Mains power cable
- Irrigation wiring

---

## Water Tank Configuration

Defined in IrrigationSystem_config.json under tanks.

Example:

```json
"tanks": [
  {
    "name": "Rainwater Tank",
    "enabled": true,
    "capacity": 5000,
    "sensorTrigPin": 20,
    "sensorEchoPin": 21,
    "sensorHeight": 1970,
    "minimumLevel": 200
  }
]
```

| Name           | Description |
|----------------|-------------|
| name           | Tank name |
| enabled        | Enable/disable tank |
| capacity       | Tank capacity (litres) |
| minimumLevel   | Minimum measurable level (mm) |
| sensorEchoPin  | GPIO echo pin |
| sensorTrigPin  | GPIO trigger pin |
| sensorHeight   | Sensor height above tank base (mm) |
| uuid           | Auto-generated (DO NOT CHANGE) |

### Tank Behaviour

- Ultrasonic sensor measures water distance
- Readings are smoothed internally
- Percentage is calculated from:
  - sensor height
  - minimum usable level
- Dashboard displays:
  - % full
  - litres remaining
  - last updated time

---

## Irrigation Zone Configuration

Defined in zones.

```json
"zones": [
  {
    "name": "Back Lawn",
    "enabled": true,
    "runtime": 300,
    "relayPin": 14
  }
]
```

| Name      | Description |
|-----------|-------------|
| name      | Zone name |
| enabled   | Enable/disable zone |
| relayPin  | GPIO relay control |
| runtime   | Default runtime (seconds) |
| uuid      | Auto-generated |

---

## Configuration Options

Defined under options.

| Name           | Description | Default |
|----------------|-------------|--------|
| debug          | Enable debug logging | false |
| elevation      | Height above sea level | 0 |
| eveHistory     | Enable EveHome history | true |
| flowRate       | Flow sensor rate (L/min @1Hz) | — |
| latitude       | Location latitude | 0 |
| longitude      | Location longitude | 0 |
| leakSensor     | Enable leak sensor | false |
| powerSwitch    | Virtual power switch | false |
| maxRuntime     | Max zone runtime (seconds) | 7200 |
| sensorFlowPin  | Flow sensor GPIO | — |
| usonicBinary   | Path to ultrasonic measurement binary (supports relative paths and `~`) | `./usonic_measure` |
| waterLeakAlert | Trigger HomeKit alert | false |
| webUIPort      | HomeKitUI port | 8581 |

---

## Ultrasonic Water Level Measurement

Includes usonic_measure.c for sensor readings.

Requires:

sudo apt install wiringPi

Compile:

gcc -o dist/usonic_measure usonic_measure.c -l wiringPi

Sensor used:

- JSN-SR04T
- Min distance: ~200mm
- Max distance: ~4500mm

---

## HomeKit Integration

Exposes:

- IrrigationSystem service
- Valve services (zones)
- Optional:
  - Leak sensor
  - Power switch

Supports:

- Siri control
- EveHome advanced features
- History logging

---

## Disclaimer

This is a personal hobby project provided **"as-is"**, with no warranty whatsoever, express or implied, including but not limited to warranties of merchantability or fitness for a particular purpose.

Building and running this project is done entirely at your own risk.

⚠️ This project involves mains power wiring. It is strongly recommended that you engage a licensed electrician where required and ensure all installations comply with local regulations.

I am not affiliated with any companies such as Apple or other related entities. The author of this project shall not be held liable for any damages or issues arising from its use.

If you find this project useful, sponsorship to support ongoing development is always appreciated.