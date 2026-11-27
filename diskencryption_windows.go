package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

const encryptionName = "BitLocker"

// diskEncryption reads the drive's BitLocker protection the way Explorer
// does (the lock on the drive icon). Unlike manage-bde or
// Get-BitLockerVolume this needs no admin rights, and it also covers Windows
// Home's "Device encryption".
func diskEncryption(dir string) string {
	drive := filepath.VolumeName(dir)
	if drive == "" {
		return "unknown"
	}
	script := "(New-Object -ComObject Shell.Application).NameSpace('" + drive + "\\').Self.ExtendedProperty('System.Volume.BitLockerProtection')"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	// A GUI app must not flash a console window.
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return bitLockerState(string(out))
}
