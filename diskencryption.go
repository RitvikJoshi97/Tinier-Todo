package main

import (
	"os"
	"path/filepath"
	"strings"
)

// bitLockerState turns Windows' System.Volume.BitLockerProtection value into
// "on", "off" or "unknown". 1 = on, 3 = encrypting, 6 = on and locked;
// 0 = can't be encrypted, 2 = off, 4 = decrypting, 5 = suspended,
// 8 = waiting to be turned on (Device encryption that isn't active yet).
// It lives here, not in the Windows file, so it's tested on every platform.
func bitLockerState(value string) string {
	switch strings.TrimSpace(value) {
	case "1", "3", "6":
		return "on"
	case "0", "2", "4", "5", "8":
		return "off"
	}
	return "unknown"
}

// fileVaultState reads the output of "fdesetup status" on macOS.
func fileVaultState(status string) string {
	switch {
	case strings.Contains(status, "FileVault is On"):
		return "on"
	case strings.Contains(status, "FileVault is Off"):
		return "off"
	}
	return "unknown"
}

// blockDeviceEncryption reports "on" when a Linux block device (its
// /sys/dev/block entry) or anything under it is a dm-crypt device. It lives
// here so it can be tested on every platform.
func blockDeviceEncryption(sysPath string, depth int) string {
	if depth > 8 {
		return "unknown"
	}
	if uuid, err := os.ReadFile(filepath.Join(sysPath, "dm", "uuid")); err == nil &&
		strings.HasPrefix(string(uuid), "CRYPT-") {
		return "on"
	}
	slaves, err := os.ReadDir(filepath.Join(sysPath, "slaves"))
	if err != nil || len(slaves) == 0 {
		if _, err := os.Stat(sysPath); err != nil {
			return "unknown"
		}
		return "off" // a plain disk or partition
	}
	state := "off"
	for _, slave := range slaves {
		switch blockDeviceEncryption(filepath.Join(sysPath, "slaves", slave.Name()), depth+1) {
		case "on":
			return "on"
		case "unknown":
			state = "unknown"
		}
	}
	return state
}
