<span align="center">

# HomeKit Irrigation System

[![version](https://img.shields.io/github/package-json/v/n0rt0nthec4t/IrrigationSystem)](https://img.shields.io/github/package-json/v/n0rt0nthec4t/IrrigationSystem)

</span>

## Parts

Built with readily available 'off the shelf' parts, housed in a sealed ABS enclosure. As the system is housed externally to the house and exposed to yhe weather, 240v wiring to the 24v AC transformer has also been house in a seperate sealed ABS enclosure for extra protection

- Raspberry Pi Zero W
- 24v AC transformer (Hunter irrigation one)
- LM2596HV AC/DC stepdown buck converter (DC output adjusted to 5v)
- JSN-SR04T ultrasonic sensor
- 8 channel solid-state relay board (highlevel trigger)
- Water flow sensor - pulsed output
- Waterproof push-on/push-off LED lit switch
- Mains power cable
- Irrigation wire

## Water Tank Configuration

The following options are available in IrrigationSystem_config.json **tanks** object, which is a array of defined watertanks.

eg:
```
    "tanks": [
        {
            "name": "Test Tank",
            "enabled": true,
            "capacity": 5000,
            "sensorTrigPin": 20,
            "sensorEchoPin": 21,
            "sensorHeight": 1970,
            "minimumLevel": 200
        }
    ],
```

| Name              | Description                                                                                   | Default    |
|-------------------|-----------------------------------------------------------------------------------------------|------------|
| name              | Name of this water tank                                                                       |            |
| enabled           | Is the tank enabled when running                                                              | false      |
| capacity          | Litre(s) capacity of this tank                                                                |            |
| minimumLevel      | Minimum reading distance (in mm) for ultrasonic sensor                                        |            |
| sensorEchoPin     | RPi GPIO pin to which ultrasonic sensor echo is attached                                      |            |
| sensorHeight      | Height (in mm) above tank base where ultrasonic sensor is mounted                             |            |
| sensorTrigPin     | RPi GPIO pin to which ultrasonic sensor trigger is attached                                   |            |
| uuid              | This is automatically generated. DO NOT CHANGE once populated                                 |            |

## Irrigation Zone Configuration

The following options are available in IrrigationSystem_config.json **zones** object, which is a array of defined irrigation zones.

eg:
```
    "zones": [
        {
            "name": "Zone 1",
            "enabled": false,
            "runtime": 300,
            "relayPin": 14
        },
        {
            "name": "Zone 2",
            "enabled": true,
            "relayPin": 15,
            "runtime": 300
        },
    ]
```

| Name              | Description                                                                                   | Default    |
|-------------------|-----------------------------------------------------------------------------------------------|------------|
| name              | Name of this irrigation zone                                                                  |            |
| enabled           | Is the zone enabled                                                                           | false      |
| replayPin         | RPi GPIO pin to which relay is attached to operate the irrigation valve                       |            |
| runtime           | Runtime (in seconds) for this irrigation zone                                                 | 300        |
| uuid              | This is automatically generated. DO NOT CHANGE once populated                                 |            |

### Configuration Options

The following options are available in IrrigationSystem_config.json **options** object.

| Name              | Description                                                                                   | Default    |
|-------------------|-----------------------------------------------------------------------------------------------|------------|
| debug             | Detailed debugging                                                                            | false      |
| elevation         | Height above sea level for the weather station                                                | 0          |
| eveHistory        | Provide history in EveHome application where applicable                                       | true       |
| flowRate          | Water sensor pulse flow rate in Litres Per Minute (LPM) at 1Hz                                |            |
| latitude          | Latitude for current location                                                                 | 0.0        |
| leakSensor        | Create a leak sensor for irrigation system. Requires flowRate and sensorFlowPin to be defined | false      |
| longitude         | Longitude for current location                                                                | 0.0        |
| powerSwitch       | Create a switch to 'virtually' power on/off the irrigation system                             | false      |
| maxRuntime        | Maxmium runtime (in seconds) for any defined irrigation zone                                  | 7200       |
| sensorFlowPin     | RPi GPIO pin to which a water flow sensor is attached                                         |            |
| waterLeakAlert    | Trigger an alert in HomeKit when a water leak is detected                                     | false      |

## Ultrasonic Waterlevel Measuring

I've included 'C' source code (usonic_measure.c) for a program which reads distances via an ultrasonic sensor. I used a JSN-SR04T waterproof ultrasonic sensor in my progect. The particular model has a minimum reading distance of 200mm and a maximum distance of 4500mm. This is mounted ontop of my watertank at 200mm above the maximum waterlevel for the tank.

This program requires the wiringPI library to be installed before compiliation of the program
- sudo apt install wiringPI

It can be compiled with:
- gcc -o dist/usonic_measure -lwiringPi usonic_measure.c

## Disclaimer

This is a personal hobby project, provided "as-is," with no warranty whatsoever, express or implied, including but not limited to warranties of merchantability or fitness for a particular purpose. Building and running this project is done entirely at your own risk.

As this project involves wiring from a mains power source, it is strongly recommended that you seek the assistance of a licensed electrician. While I’ve been running this project successfully at my home, your experience may vary.

Please note that I am not affiliated with any companies, including but not limited to Apple, or any other entities. The author of this project shall not be held liable for any damages or issues arising from its use. If you do encounter any problems with the source code, feel free to reach out, and we can discuss possible solutions