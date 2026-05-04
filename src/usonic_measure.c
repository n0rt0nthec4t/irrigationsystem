// gcc -o usonic_measure -lwiringPi usonic_measure.c
// https://github.com/dmeziere/rpi-hc-sr04/blob/master/util/hc-sr04.c

#include <wiringPi.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <unistd.h>

int TRIG, ECHO, TIMES;

static int ping()
{
    long start;
    long ping;
    long pong;
    double distance;
    long timeout = 500000; // 0.5 sec

    pinMode(TRIG, OUTPUT);
    pinMode(ECHO, INPUT);

    digitalWrite(TRIG, LOW);
    delayMicroseconds(2);

    digitalWrite(TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG, LOW);

    // Wait for echo HIGH
    start = micros();
    while (digitalRead(ECHO) == LOW && (micros() - start) < timeout) {
    }

    if ((micros() - start) >= timeout) {
        printf("OUT OF RANGE\n");
        return -1;
    }

    ping = micros();

    // Wait for echo LOW
    start = micros();
    while (digitalRead(ECHO) == HIGH && (micros() - start) < timeout) {
    }

    if ((micros() - start) >= timeout) {
        printf("OUT OF RANGE\n");
        return -1;
    }

    pong = micros();

    distance = (double)(pong - ping) * 0.017150;

    printf("DISTANCE %.2f\n", distance);
    return 1;
}

int main (int argc, char *argv[])
{
    if (argc != 3) {
        printf ("usage: %s <trigger> <echo>\n\nWhere:\n- trigger is the BCM trigger pin number.\n- echo is the BCM echo pin number.\nUsing trigger %d and echo %d.\n", argv[0], argv[1], argv[2]);
    } else {
        TRIG = atoi(argv[1]);
        ECHO = atoi(argv[2]);
 
        if (wiringPiSetupGpio() == -1) {
            exit(EXIT_FAILURE);
        }
        if (setuid(getuid()) < 0) {
            perror("Dropping privileges failed.\n");
            exit(EXIT_FAILURE);
        }

        ping();
    }
    return 0;
}