package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"syscall"
)

const encryptionName = "disk encryption"

// diskEncryption finds the block device holding dir and follows it down
// through device-mapper layers (LVM on LUKS, for example) looking for a
// dm-crypt device. An eCryptfs or fscrypt home folder also counts. Anything
// it can't follow, such as btrfs subvolumes or network drives, is "unknown".
func diskEncryption(dir string) string {
	if fs := mountType(dir); fs == "ecryptfs" {
		return "on"
	}
	var st syscall.Stat_t
	if err := syscall.Stat(dir, &st); err != nil {
		return "unknown"
	}
	major, minor := (st.Dev>>8)&0xfff|(st.Dev>>32)&^0xfff, st.Dev&0xff|(st.Dev>>12)&^0xff
	if major == 0 {
		return "unknown" // a virtual device: btrfs, overlayfs, tmpfs…
	}
	return blockDeviceEncryption(fmt.Sprintf("/sys/dev/block/%d:%d", major, minor), 0)
}

// mountType is the filesystem type of the mount that holds path.
func mountType(path string) string {
	file, err := os.Open("/proc/self/mounts")
	if err != nil {
		return ""
	}
	defer file.Close()
	best, fsType := "", ""
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 {
			continue
		}
		mount := strings.ReplaceAll(fields[1], `\040`, " ")
		if (path == mount || strings.HasPrefix(path, strings.TrimSuffix(mount, "/")+"/")) && len(mount) > len(best) {
			best, fsType = mount, fields[2]
		}
	}
	return fsType
}
