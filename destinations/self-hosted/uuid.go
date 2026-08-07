package main

import (
	"crypto/rand"
	"fmt"
)

// newUUIDv4 generates a random UUIDv4 without pulling in an external
// dependency, mirroring the Worker's use of the platform's crypto.randomUUID().
func newUUIDv4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failing means the platform CSPRNG is broken
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10

	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
