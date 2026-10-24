<span align="center">

# HomeKit Irrigation System

[![version](https://img.shields.io/github/package-json/v/n0rt0nthec4t/irrigationsystem)](https://img.shields.io/github/package-json/v/n0rt0nthec4t/irrigationsystem)

</span>

## Parts

- Raspberry Pi supported by `rpio`, such as a Raspberry Pi Zero W
- 24 V AC transformer for irrigation valves
- LM2596HV AC/DC step-down converter with 5 V output
- Relay board compatible with the irrigation valves, using high-level GPIO triggers
- JSN-SR04T waterproof ultrasonic sensor for each monitored tank
- Water flow sensor with pulse output
- Waterproof push-on/push-off LED switch
- Sealed ABS enclosure, power cable and irrigation wiring

Use Node.js 22 or 24. GPIO pins use BCM numbering. This standalone HAP-NodeJS
controller provides one HomeKit irrigation accessory with multiple valve zones,
optional tank monitoring, flow-based leak detection and EveHome history.
Homebridge is not required.

The system is installed externally. Keep mains wiring and the 240 V to 24 V
transformer isolated in a separate enclosure.

## GPIO Access

The irrigation controller uses `/dev/gpiomem` for GPIO access. Its `rpio` GPIO
access can run without root when the service user belongs to the `gpio` group
and has read/write permission on that device. Configuring group membership or
udev permissions requires administrator access. See the
[rpio GPIO access requirements](https://github.com/jperkin/node-rpio#enable-devgpiomem-access).

The `rpio` library also requires GPIO interrupts to be disabled on newer Raspberry
Pi OS kernels to avoid crashes when polling pins. This controller uses polling
for flow sensors and the ultrasonic GPIO fallback. Add the following line to the
boot configuration and reboot:

```ini
dtoverlay=gpio-no-irq
```

Use `/boot/firmware/config.txt` on current Raspberry Pi OS releases, or
`/boot/config.txt` on older releases. Editing this file requires administrator
access. The overlay controls GPIO interrupts; device permissions control whether
the application can run without root. See the
[rpio interrupt requirements](https://github.com/jperkin/node-rpio#disable-gpio-interrupts)
and [Raspberry Pi boot configuration documentation](https://www.raspberrypi.com/documentation/computers/config_txt.html).

The optional `usonic_measure` helper uses wiringPi rather than `rpio`. Check that
the service user can also access GPIO through that helper before running the
complete application without root.

## Irrigation System Configuration

Configure the **zones**, **tanks** and **options** entries in
`irrigationsystem_config.json`. The default file is read from the current working
directory; pass another file path when starting the controller if needed.

For example:

```json
{
  "power": true,
  "zones": [
    {
      "name": "Back Lawn",
      "enabled": true,
      "runtime": 300,
      "relayPin": 14
    }
  ],
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
  ],
  "options": {
    "debug": false,
    "eveHistory": true,
    "hkPairingCode": "031-45-154",
    "sensorFlowPin": 18,
    "flowRate": 1,
    "webUIPort": 8582,
    "webUIBearerToken": ""
  }
}
```

The example flow calibration is illustrative; measure and set the value for your
sensor. Omit tank and flow-sensor configuration when those sensors are not fitted.

| Name | Description | Default |
|------|-------------|---------|
| power | Enable irrigation system operation | false |
| pauseTimeout | Pause expiry as Unix time in seconds | 0 |
| hkUsername | Automatically generated HomeKit username | Generated on first startup |
| serialNumber | HomeKit accessory serial number | Generated on first startup |
| zones | Array of irrigation zones | Empty |
| tanks | Array of monitored water tanks | Empty |
| programs | Eve scheduling settings: enabled and schedules | Disabled, empty schedules |

HomeKit identities and zone/tank UUIDs are generated and saved to the configuration
file. Keep them unchanged after pairing. A configured pause disables system power
until irrigation resumes.

HomeKit exposes an IrrigationSystem service and a Valve service for each zone.
Optional services provide leak detection and a virtual power switch. Siri control,
EveHome features and history logging are supported.

### Irrigation Zones

The following options are available in each **zones** entry.

| Name | Description | Default |
|------|-------------|---------|
| name | Zone name | Zone 1, Zone 2… |
| enabled | Enable the zone | false |
| relayPin | BCM relay pin or array of relay pins | Omitted |
| runtime | Default watering duration in seconds | 300 |
| uuid | Stable zone identifier | Generated on first startup |

One zone runs at a time. Zone runtime is limited by `options.maxRuntime`.
GPIO pins must be integers from 0 to 26; numeric strings are accepted. Empty relay
arrays stay empty, and invalid GPIO values are not converted to GPIO 0.

### Water Tanks

The following options are available in each **tanks** entry.

| Name | Description | Default |
|------|-------------|---------|
| name | Tank name | Tank 1, Tank 2… |
| enabled | Enable tank monitoring | false |
| capacity | Usable tank capacity in litres | 0 |
| sensorTrigPin | BCM trigger pin | Omitted |
| sensorEchoPin | BCM echo pin | Omitted |
| sensorHeight | Sensor height above the tank base in mm | 0 |
| minimumLevel | Bottom reserve height excluded from usable water in mm | 0 |
| uuid | Stable tank identifier | Generated on first startup |

Each tank is measured every minute. A poll takes five readings, with a 100 ms
recovery delay between measurements. At least three readings within the sensor
range and configured tank height are required; their median updates the level.
Failed samples retain the last valid level, and debug logs show the raw distances
and configured sensor height.

Changing tank pins or dimensions cancels the current sample and starts a fresh
one after the recovery delay. Correcting initially invalid dimensions starts
polling without a restart.

Usable water height is `sensorHeight - distance - minimumLevel`, clamped between
zero and `sensorHeight - minimumLevel - 200`. The 200 mm allowance accounts for
the sensor's blind zone. Configure `capacity` as usable litres between those empty
and full points. Tank geometry makes the litre display an estimate.

### Configuration Options

The following options are available in the **options** object.

| Name | Description | Default |
|------|-------------|---------|
| debug | Detailed debugging | false |
| eveHistory | Provide EveHome history | true |
| hkPairingCode | HomeKit pairing code: "xxx-xx-xxx" or "xxxx-xxxx" | 031-45-154 |
| flowRate | Flow sensor calibration in L/min at 1 Hz | 0 |
| sensorFlowPin | BCM flow-sensor input pin | Omitted |
| leakSensor | Enable flow-based leak detection | false |
| waterLeakAlert | Enable HomeKit leak alerting | false |
| powerSwitch | Expose a virtual power switch | false |
| maxRuntime | Maximum zone runtime in seconds | 7200 |
| latitude | Location latitude | 0 |
| longitude | Location longitude | 0 |
| elevation | Height above sea level | 0 |
| usonicBinary | Path to the ultrasonic measurement binary | ./usonic_measure |
| webUIPort | Web UI port; 0 disables the Web UI | 0 |
| webUIBearerToken | Web UI password; an empty value disables authentication | Empty |

When an `options` object is present, set `eveHistory` explicitly to `true` to enable
history. Flow usage is calculated from accepted sensor pulses: each pulse
represents `flowRate / 60` litres. Verify calibration against a measured volume.
Previously undercounted usage cannot be reconstructed from saved run totals.

For example, `webUIPort: 8582` enables the UI at `http://<pi-address>:8582`.
The UI provides a live dashboard, zone and tank configuration, system options,
pairing management, logs, backup and restore. Some saved changes require restart.
Its restart action exits with status 1 so a process manager configured to restart
on failure can relaunch the application.

Set `webUIBearerToken` to a non-empty password to require authentication for API
access. Browser credentials can be retained for the session or remembered for
that browser. Authenticated live log streaming remains available. Log sources are
journald, a configured log file, or console capture as a fallback.

The dashboard shows zone state, tank percentage, estimated litres, capacity and
reading time. Tanks without a valid measurement show **No reading**; measurements
older than five minutes show **Stale reading**.

Water usage charts cover completed zone runs over the last 7, 14 or 30 calendar
days. Ongoing runs and unassigned flow are excluded. A run is recorded on the day
it finishes, and daily averages include zero-use days. Bars use a linear scale,
with no bar for zero usage.

## Ultrasonic Measurement

`src/usonic_measure.c` provides ultrasonic timing through an external binary.
Install wiringPi on the Raspberry Pi and compile from the project root:

```sh
sudo apt install wiringPi
gcc -o usonic_measure src/usonic_measure.c -l wiringPi
```

The default binary path is `./usonic_measure`, relative to the controller's working
directory. Set `options.usonicBinary` if the binary is installed elsewhere.
The JSN-SR04T measurement range used by the controller is 200–4500 mm. When the
binary is unavailable, the controller can use its Node.js GPIO fallback with
reduced timing accuracy.

## Disclaimer

This is a personal hobby project provided **"as-is"**, with no warranty whatsoever,
express or implied, including warranties of merchantability or fitness for a
particular purpose. Building and running this project is done at your own risk.

This project involves mains power wiring. Engage a licensed electrician where
required and ensure installations comply with local regulations.

I am not affiliated with Apple or other related companies. The author shall not
be held liable for damages or issues arising from use of this project.

If you find this project useful, sponsorship to support ongoing development is
always appreciated.
