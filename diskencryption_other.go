//go:build !darwin && !windows && !linux

package main

const encryptionName = "disk encryption"

func diskEncryption(string) string { return "unknown" }
