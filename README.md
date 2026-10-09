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
- Configuration backup/restore
- Optional bearer-token authentication

### Access

```txt
http://<device-ip>:8582
```

Port is configurable via:

```json
options.webUIPort
```

### Authentication

HomeKitUI supports optional bearer-token authentication.

When configured:

- API access requires a bearer token
- Browser UI stores the token locally after first authentication
- Live log streaming remains supported via secure SSE token fallback

Example:

```json
"webUIBearerToken": "your-secret-token"
```

To disable authentication:

```json
"webUIBearerToken": ""
```

### Dashboard

Displays:

- Water tank levels (percentage + litres)
- Tank capacity
- Last updated readings
- Zone runtime state
- Water usage information

Tank measurements are taken every minute and the dashboard refreshes automatically. Tanks without a valid measurement show **No reading**; measurements older than five minutes show **Stale reading**. Tank litres are estimated from the configured capacity and measured usable-height percentage.

Water usage charts cover completed zone runs over the last 7, 14, or 30 calendar days. Ongoing runs and unassigned flow are excluded. A run is recorded on the day it finishes, and the daily average includes zero-use days. Bars use a linear scale, with no bar for zero usage.

Usage is calculated from accepted flow-sensor pulses. `options.flowRate` is the flow rate in litres per minute at 1 Hz, so each pulse represents `flowRate / 60` litres. Verify this calibration against a measured volume. Previously undercounted usage cannot be reconstructed from saved run totals.

### Notes

- Fully self-contained UI (no external frontend)
- Config changes may require restart
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

Defined in `IrrigationSystem_config.json` under `tanks`.

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

| Name | Description |
|------|-------------|
| `name` | Tank name |
| `enabled` | Enable/disable tank |
| `capacity` | Tank capacity (litres) |
| `minimumLevel` | Minimum measurable level (mm) |
| `sensorEchoPin` | GPIO echo pin |
| `sensorTrigPin` | GPIO trigger pin |
| `sensorHeight` | Sensor height above tank base (mm) |
| `uuid` | Auto-generated (DO NOT CHANGE) |

### Tank Behaviour

- Ultrasonic sensor measures water distance
- Readings are smoothed internally
- Usable water height is `sensorHeight - distance - minimumLevel`, clamped to zero
- Full usable height is `sensorHeight - minimumLevel - 200`, accounting for the sensor's 200 mm blind zone
- `capacity` represents usable litres between those empty/full points; tank geometry makes the litre display an estimate
- Correcting initially invalid dimensions starts automatic polling without a restart
- Dashboard displays:
  - % full
  - litres remaining
  - last updated time

---

## Irrigation Zone Configuration

Defined in `zones`.

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

| Name | Description |
|------|-------------|
| `name` | Zone name |
| `enabled` | Enable/disable zone |
| `relayPin` | GPIO relay control pin or array of pins |
| `runtime` | Default runtime (seconds) |
| `uuid` | Auto-generated |

---

## Configuration Options

Defined under `options`.

| Name | Description | Default |
|------|-------------|---------|
| `debug` | Enable debug logging | `false` |
| `elevation` | Height above sea level | `0` |
| `eveHistory` | Enable EveHome history | `true` |
| `flowRate` | Flow sensor rate (L/min @1Hz) | — |
| `latitude` | Location latitude | `0` |
| `longitude` | Location longitude | `0` |
| `leakSensor` | Enable leak sensor | `false` |
| `powerSwitch` | Virtual power switch | `false` |
| `maxRuntime` | Maximum zone runtime (seconds) | `7200` |
| `sensorFlowPin` | Flow sensor GPIO | — |
| `usonicBinary` | Path to ultrasonic measurement binary | `./usonic_measure` |
| `waterLeakAlert` | Trigger HomeKit alert | `false` |
| `webUIPort` | HomeKitUI port | `8581` |
| `webUIBearerToken` | Optional HomeKitUI bearer token | `""` |

---

## Ultrasonic Water Level Measurement

Includes `usonic_measure.c` for accurate ultrasonic sensor timing.

Requires:

```bash
sudo apt install wiringPi
```

Compile:

```bash
gcc -o dist/usonic_measure src/usonic_measure.c -l wiringPi
```

Sensor used:

- JSN-SR04T
- Minimum distance: ~200mm
- Maximum distance: ~4500mm

---

## HomeKit Integration

Exposes:

- IrrigationSystem service
- Valve services (zones)

Optional services:

- Leak sensor
- Power switch

Supports:

- Siri control
- EveHome advanced features
- History logging

---

## Development

The shared `HomeKitDevice`, `HomeKitHistory`, and `HomeKitUI` modules are Git submodules. Clone with submodules, or initialise them after cloning:

```sh
git submodule update --init --recursive
npm install
npm run check
```

Requires Node.js 22 or 24. The regression tests cover valve lifecycle and HomeKit configuration changes through the built controller, flow accounting at zone boundaries, GPIO configuration, ultrasonic measurements, water usage charts, and dashboard refresh behaviour. GPIO, clocks, measurement processes, browser APIs, and persistence are mocked; HAP services use the real library. The test command also runs the shared device and history suites.

Run `npm test` for the regression suite, `npm run lint` for source checks, or `npm run build` to refresh `dist`. Hardware measurements and flow calibration should also be checked on the Raspberry Pi.

---

## Disclaimer

This is a personal hobby project provided **"as-is"**, with no warranty whatsoever, express or implied, including but not limited to warranties of merchantability or fitness for a particular purpose.

Building and running this project is done entirely at your own risk.

⚠️ This project involves mains power wiring. It is strongly recommended that you engage a licensed electrician where required and ensure all installations comply with local regulations.

I am not affiliated with any companies such as Apple or other related entities. The author of this project shall not be held liable for any damages or issues arising from its use.

If you find this project useful, sponsorship to support ongoing development is always appreciated.