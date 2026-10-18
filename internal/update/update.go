// Package update checks GitHub Releases for a newer version and replaces
// the running binary in place. systemd (Restart=always) brings the new
// version up after the process exits.
package update

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rhisijmuiden/unify-syslog-server/internal/version"
)

type Release struct {
	Tag         string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	Prerelease  bool      `json:"prerelease"`
	PublishedAt time.Time `json:"published_at"`
	HTMLURL     string    `json:"html_url"`
	Assets      []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

type CheckResult struct {
	Current   string    `json:"current"`
	Latest    string    `json:"latest"`
	Available bool      `json:"available"`
	Notes     string    `json:"notes"`
	URL       string    `json:"url"`
	Published time.Time `json:"published"`
	CheckedAt time.Time `json:"checked_at"`
}

type Updater struct {
	Repo   string
	Client *http.Client

	mu      sync.Mutex
	running bool
	state   string
}

func New() *Updater {
	return &Updater{Repo: version.Repo, Client: &http.Client{Timeout: 5 * time.Minute}}
}

func (u *Updater) State() (bool, string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.running, u.state
}

func (u *Updater) setState(s string) {
	u.mu.Lock()
	u.state = s
	u.mu.Unlock()
}

func (u *Updater) latest(ctx context.Context, pre bool) (*Release, error) {
	url := "https://api.github.com/repos/" + u.Repo + "/releases/latest"
	if pre {
		url = "https://api.github.com/repos/" + u.Repo + "/releases?per_page=10"
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "unify-syslog-server/"+version.Version)
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, fmt.Errorf("no releases published yet on github.com/%s", u.Repo)
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub API: %s", resp.Status)
	}
	if pre {
		var rs []Release
		if err := json.NewDecoder(resp.Body).Decode(&rs); err != nil {
			return nil, err
		}
		if len(rs) == 0 {
			return nil, fmt.Errorf("no releases found")
		}
		return &rs[0], nil
	}
	var r Release
	return &r, json.NewDecoder(resp.Body).Decode(&r)
}

func (u *Updater) Check(ctx context.Context, pre bool) (*CheckResult, error) {
	r, err := u.latest(ctx, pre)
	if err != nil {
		return nil, err
	}
	return &CheckResult{
		Current: version.Version, Latest: strings.TrimPrefix(r.Tag, "v"),
		Available: Newer(r.Tag, version.Version), Notes: r.Body, URL: r.HTMLURL,
		Published: r.PublishedAt, CheckedAt: time.Now(),
	}, nil
}

// AssetName is the release tarball for this platform.
func AssetName() string {
	return fmt.Sprintf("unify-syslog-server_linux_%s.tar.gz", runtime.GOARCH)
}

// Apply downloads, verifies (checksums.txt) and installs the latest
// release, then calls restart.
func (u *Updater) Apply(ctx context.Context, pre bool, restart func()) error {
	u.mu.Lock()
	if u.running {
		u.mu.Unlock()
		return fmt.Errorf("an update is already running")
	}
	u.running = true
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.running = false
		u.mu.Unlock()
	}()

	u.setState("fetching release")
	r, err := u.latest(ctx, pre)
	if err != nil {
		u.setState("error: " + err.Error())
		return err
	}
	if !Newer(r.Tag, version.Version) {
		u.setState("already up to date")
		return fmt.Errorf("version %s is already the latest", version.Version)
	}
	var assetURL, sumURL string
	for _, a := range r.Assets {
		switch a.Name {
		case AssetName():
			assetURL = a.URL
		case "checksums.txt":
			sumURL = a.URL
		}
	}
	if assetURL == "" {
		err := fmt.Errorf("release %s does not contain %s", r.Tag, AssetName())
		u.setState("error: " + err.Error())
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	dir := filepath.Dir(exe)

	u.setState("downloading " + r.Tag)
	tmp, err := os.CreateTemp(dir, ".update-*.tar.gz")
	if err != nil {
		u.setState("error: " + err.Error())
		return fmt.Errorf("no write permission in %s: %w", dir, err)
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	if err := u.download(ctx, assetURL, io.MultiWriter(tmp, h)); err != nil {
		tmp.Close()
		u.setState("error: " + err.Error())
		return err
	}
	tmp.Close()
	if sumURL != "" {
		u.setState("verifying checksum")
		want, err := u.checksum(ctx, sumURL, AssetName())
		if err != nil {
			u.setState("error: " + err.Error())
			return err
		}
		if got := hex.EncodeToString(h.Sum(nil)); got != want {
			err := fmt.Errorf("checksum mismatch (%s != %s)", got, want)
			u.setState("error: " + err.Error())
			return err
		}
	}
	u.setState("installing")
	newBin := exe + ".new"
	if err := extractBinary(tmp.Name(), "unify-syslog", newBin); err != nil {
		u.setState("error: " + err.Error())
		return err
	}
	os.Remove(exe + ".old")
	if err := os.Rename(exe, exe+".old"); err != nil {
		return err
	}
	if err := os.Rename(newBin, exe); err != nil {
		os.Rename(exe+".old", exe)
		return err
	}
	u.setState("restarting into " + r.Tag)
	if restart != nil {
		go func() {
			time.Sleep(1500 * time.Millisecond)
			restart()
		}()
	}
	return nil
}

func (u *Updater) download(ctx context.Context, url string, w io.Writer) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "unify-syslog-server/"+version.Version)
	resp, err := u.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download: %s", resp.Status)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

func (u *Updater) checksum(ctx context.Context, url, name string) (string, error) {
	var b strings.Builder
	if err := u.download(ctx, url, &b); err != nil {
		return "", err
	}
	sc := bufio.NewScanner(strings.NewReader(b.String()))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fmt.Errorf("no checksum for %s", name)
}

func extractBinary(tgz, want, dst string) error {
	f, err := os.Open(tgz)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s not found in archive", want)
		}
		if err != nil {
			return err
		}
		if filepath.Base(h.Name) != want || h.Typeflag != tar.TypeReg {
			continue
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
}

// Newer reports whether tag a is a higher semantic version than b.
func Newer(a, b string) bool {
	pa, pb := parse(a), parse(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	// A release without pre-release suffix beats one with.
	sa, sb := suffix(a), suffix(b)
	if sa == "" && sb != "" {
		return true
	}
	return false
}

func parse(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, p := range strings.SplitN(v, ".", 3) {
		out[i], _ = strconv.Atoi(p)
	}
	return out
}

func suffix(v string) string {
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		return v[i:]
	}
	return ""
}
