package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
)

// ---------- private data folder ----------

// secureDataDir makes the data folder readable by this user only: folders
// 0700 and files 0600. Earlier versions created them readable by everyone
// with an account on the computer. (On Windows this changes nothing; the
// folder inherits the user profile's permissions.)
func secureDataDir(dir string) {
	if goruntime.GOOS == "windows" {
		return
	}
	_ = fsWalkPrivate(dir)
}

func fsWalkPrivate(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Mode()&fs.ModeSymlink != 0 {
			return nil
		}
		want := fs.FileMode(0o600)
		if d.IsDir() {
			want = 0o700
		}
		if info.Mode().Perm()&0o077 != 0 {
			if err := os.Chmod(path, want); err != nil {
				log.Printf("Couldn't make %s private: %v", path, err)
			}
		}
		return nil
	})
}

// ---------- MCP token ----------

// newMCPToken returns a random secret that MCP clients send as
// "Authorization: Bearer <token>".
func newMCPToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("no randomness for the MCP token: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// requestToken is the token a request carries: in an "Authorization: Bearer"
// header, or as ?token= for clients that can only be given a URL.
func requestToken(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); len(auth) > 7 && strings.EqualFold(auth[:7], "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return r.URL.Query().Get("token")
}

// requireToken rejects requests without the right token, so other programs
// on this computer can't use the boards without being set up for it.
func requireToken(token func() string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := token()
		got := requestToken(r)
		if want == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="tinier-todo"`)
			http.Error(w, "Unauthorized: send the token from Tinier Todo's Tools → MCP as "+
				"\"Authorization: Bearer <token>\"", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- links ----------

// cleanLink checks a ticket's link. Links open in the system's default
// handler, so only web and email links are allowed: a file:// path or another
// app's URL scheme could open or run something on a click. A link without a
// scheme, such as "example.com/page", gets https:// in front.
func cleanLink(link string) (string, error) {
	original := strings.TrimSpace(link)
	link = original
	if link == "" {
		return "", nil
	}
	lower := strings.ToLower(link)
	if !strings.Contains(lower, "://") && !strings.HasPrefix(lower, "mailto:") {
		link = "https://" + link
	}
	parsed, err := url.Parse(link)
	if err == nil {
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https":
			if parsed.Host != "" {
				return link, nil
			}
		case "mailto":
			if parsed.Opaque != "" {
				return link, nil
			}
		}
	}
	return "", fmt.Errorf("invalid link %q: use a web address (https://…) or mailto:", original)
}

// ---------- disk encryption ----------

// DiskEncryptionStatus says whether the disk that holds the boards is
// encrypted. State is "on", "off" or "unknown"; Name is the system's name for
// its disk encryption (FileVault, BitLocker, LUKS…).
type DiskEncryptionStatus struct {
	State string `json:"state"`
	Name  string `json:"name"`
}

// DiskEncryption checks the disk that holds the data folder. The check is
// different on each platform: see diskencryption_*.go.
func (a *App) DiskEncryption() DiskEncryptionStatus {
	dir, err := defaultDataDir()
	if err != nil {
		return DiskEncryptionStatus{State: "unknown", Name: encryptionName}
	}
	return DiskEncryptionStatus{State: diskEncryption(dir), Name: encryptionName}
}
