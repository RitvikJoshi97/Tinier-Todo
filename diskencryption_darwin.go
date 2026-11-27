package main

import (
	"context"
	"os/exec"
	"time"
)

const encryptionName = "FileVault"

// diskEncryption asks fdesetup, which needs no admin rights for "status".
// FileVault covers the whole startup disk.
func diskEncryption(string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/fdesetup", "status").Output()
	if err != nil {
		return "unknown"
	}
	return fileVaultState(string(out))
}
