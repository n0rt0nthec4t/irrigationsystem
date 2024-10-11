Requires HAP_NodeJS 1.x.x

usonic require wiringPI library install. Compiles with 'gcc -o usonic_measure -lwiringPi usonic_measure.c'

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