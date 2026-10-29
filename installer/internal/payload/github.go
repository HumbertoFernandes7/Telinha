// SPDX-License-Identifier: GPL-3.0-or-later

package payload

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// Repo is where the add-on payload is published (GitHub releases).
	RepoOwner = "HumbertoFernandes7"
	RepoName  = "Telinha"
	// AssetPattern is the payload asset name (path.Match syntax).
	AssetPattern = "Telinha-addon-*.zip"
	// ChecksumAsset is an optional release asset: the payload's version.json (cross-checked against the
	// one inside the zip) or a small JSON with the zip's SHA-256. "<zip>.sha256" (sha256sum format) is
	// also used when present.
	ChecksumAsset = "version.json"
	// IncludePrereleases: while Telinha is in test, its releases are marked pre-release. Set to false
	// once stable releases exist.
	IncludePrereleases = true

	MaxZipSize = 64 << 20 // the payload is a few hundred KiB; anything this big is wrong
	maxJSON    = 4 << 20
)

// Release / Asset are the fields we use from the GitHub REST API.
type Release struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	PublishedAt time.Time `json:"published_at"`
	CreatedAt   time.Time `json:"created_at"`
	Assets      []Asset   `json:"assets"`
}

type Asset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"` // "sha256:<hex>", computed by GitHub on upload
	URL    string `json:"browser_download_url"`
}

// Client talks to GitHub. APIBase is overridable for tests.
type Client struct {
	HTTP      *http.Client
	APIBase   string // default https://api.github.com
	UserAgent string
}

func NewClient(userAgent string) *Client {
	return &Client{HTTP: &http.Client{Timeout: 5 * time.Minute}, APIBase: "https://api.github.com", UserAgent: userAgent}
}

func (c *Client) get(ctx context.Context, url string, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.UserAgent)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	return resp, nil
}

// Latest returns the newest release (drafts skipped, pre-releases per IncludePrereleases) that has a
// payload asset, and that asset.
func (c *Client) Latest(ctx context.Context) (*Release, *Asset, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=30", strings.TrimRight(c.APIBase, "/"), RepoOwner, RepoName)
	resp, err := c.get(ctx, url, "application/vnd.github+json")
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	var releases []Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxJSON)).Decode(&releases); err != nil {
		return nil, nil, fmt.Errorf("reading release list: %w", err)
	}
	rel, asset := PickRelease(releases, IncludePrereleases)
	if rel == nil {
		return nil, nil, ErrNoRelease
	}
	return rel, asset, nil
}

// ErrNoRelease means no published release carries a payload asset yet.
var ErrNoRelease = errors.New("no release with a " + AssetPattern + " asset")

// PickRelease chooses the newest eligible release that has an asset matching AssetPattern.
func PickRelease(releases []Release, includePre bool) (*Release, *Asset) {
	rs := append([]Release(nil), releases...)
	when := func(r Release) time.Time {
		if !r.PublishedAt.IsZero() {
			return r.PublishedAt
		}
		return r.CreatedAt
	}
	sort.SliceStable(rs, func(i, j int) bool { return when(rs[i]).After(when(rs[j])) })
	for i := range rs {
		r := &rs[i]
		if r.Draft || (r.Prerelease && !includePre) {
			continue
		}
		var best *Asset
		for j := range r.Assets {
			a := &r.Assets[j]
			if ok, _ := path.Match(AssetPattern, a.Name); ok && (best == nil || a.Name > best.Name) {
				best = a
			}
		}
		if best != nil {
			return r, best
		}
	}
	return nil, nil
}

// Expected is one SHA-256 the payload must have, and where it came from.
type Expected struct {
	SHA256 string
	Source string
}

// Checks is everything published next to the payload that the download must agree with.
type Checks struct {
	Hashes []Expected // zip SHA-256: GitHub asset digest, <zip>.sha256 asset, version.json asset, release notes
	// Manifest is a payload version.json published as a release asset (if any); the version.json inside
	// the zip must list exactly the same files.
	Manifest *Manifest
}

var hex64 = regexp.MustCompile(`(?i)\b[0-9a-f]{64}\b`)

// ReleaseChecks collects every published checksum for the asset.
func (c *Client) ReleaseChecks(ctx context.Context, rel *Release, asset *Asset) (*Checks, error) {
	ch := &Checks{}
	if d, ok := strings.CutPrefix(strings.ToLower(asset.Digest), "sha256:"); ok && normHash(d) != "" {
		ch.Hashes = append(ch.Hashes, Expected{d, "GitHub (digest do asset)"})
	}
	for _, a := range rel.Assets {
		isSum := strings.EqualFold(a.Name, asset.Name+".sha256")
		isVersion := strings.EqualFold(a.Name, ChecksumAsset)
		if !isSum && !isVersion {
			continue
		}
		data, err := c.fetchSmall(ctx, a.URL)
		if err != nil {
			return nil, fmt.Errorf("downloading %s: %w", a.Name, err)
		}
		switch {
		case isSum:
			h := HashFromSumFile(string(data), asset.Name)
			if h == "" {
				return nil, fmt.Errorf("%s: no SHA-256 for %s", a.Name, asset.Name)
			}
			ch.Hashes = append(ch.Hashes, Expected{h, a.Name})
		case isVersion:
			if m, err := ParseManifest(data); err == nil {
				ch.Manifest = m
			} else if h := HashFromVersionJSON(data, asset.Name); h != "" {
				ch.Hashes = append(ch.Hashes, Expected{h, ChecksumAsset})
			}
		}
	}
	if h := HashFromReleaseBody(rel.Body, asset.Name); h != "" {
		ch.Hashes = append(ch.Hashes, Expected{h, "notas da release"})
	}
	return ch, nil
}

func (c *Client) fetchSmall(ctx context.Context, url string) ([]byte, error) {
	resp, err := c.get(ctx, url, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, maxJSON))
}

// HashFromSumFile reads sha256sum output ("<hex>  <name>"): the line for assetName, or the only hash.
func HashFromSumFile(text, assetName string) string {
	var all []string
	for _, l := range strings.Split(text, "\n") {
		f := strings.Fields(l)
		if len(f) == 0 || normHash(f[0]) == "" {
			continue
		}
		if len(f) >= 2 && strings.EqualFold(strings.TrimPrefix(f[1], "*"), assetName) {
			return normHash(f[0])
		}
		all = append(all, normHash(f[0]))
	}
	if len(all) == 1 {
		return all[0]
	}
	return ""
}

// HashFromVersionJSON finds the SHA-256 of the zip assetName in a small JSON document (not a payload
// manifest, whose per-file hashes are handled by Checks.Manifest). Accepted shapes:
//
//	{"sha256": "<hex>"}   (optionally with "file"/"asset"/"name"/"zip" = assetName)
//	{"<assetName>": "<hex>"}  /  {"<assetName>": {"sha256": "<hex>"}}
//	{"assets": [{"name": "<assetName>", "sha256": "<hex>"}]}  /  {"assets": {"<assetName>": "<hex>"}}
func HashFromVersionJSON(data []byte, assetName string) string {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return ""
	}
	return findHash(v, assetName)
}

func findHash(v any, assetName string) string {
	switch t := v.(type) {
	case map[string]any:
		// An object that names another .zip is about another file: ignore it entirely.
		for _, k := range []string{"file", "asset", "name", "zip", "filename", "fileName"} {
			if s, ok := t[k].(string); ok && strings.HasSuffix(strings.ToLower(s), ".zip") &&
				!strings.EqualFold(path.Base(strings.ReplaceAll(s, "\\", "/")), assetName) {
				return ""
			}
		}
		for _, k := range []string{"sha256", "sha-256", "SHA256", "SHA-256", "zipSha256", "digest"} {
			if s, ok := t[k].(string); ok {
				if h := normHash(s); h != "" {
					return h
				}
			}
		}
		for k, sub := range t {
			if strings.EqualFold(k, assetName) {
				if s, ok := sub.(string); ok {
					return normHash(s)
				}
				return findHash(sub, assetName)
			}
		}
		for _, k := range []string{"assets", "zip", "checksums", "release"} {
			if sub, ok := t[k]; ok {
				if h := findHash(sub, assetName); h != "" {
					return h
				}
			}
		}
	case []any:
		for _, e := range t {
			if h := findHash(e, assetName); h != "" {
				return h
			}
		}
	}
	return ""
}

func normHash(s string) string {
	s = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "sha256:")
	if len(s) == 64 && hex64.MatchString(s) {
		return s
	}
	return ""
}

// HashFromReleaseBody finds the SHA-256 for assetName in release notes: a line naming the asset and a
// 64-hex string (sha256sum style "<hex>  name", "SHA-256 (name) = <hex>", markdown tables...), or, if no
// line names it, a single line labelled SHA-256 / sha256.
func HashFromReleaseBody(body, assetName string) string {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	for _, l := range lines {
		if strings.Contains(strings.ToLower(l), strings.ToLower(assetName)) {
			if m := hex64.FindString(l); m != "" {
				return strings.ToLower(m)
			}
		}
	}
	var found []string
	for _, l := range lines {
		ll := strings.ToLower(l)
		if strings.Contains(ll, "sha-256") || strings.Contains(ll, "sha256") {
			if m := hex64.FindString(l); m != "" && !strings.Contains(ll, ".zip") {
				found = append(found, strings.ToLower(m))
			}
		}
	}
	if len(found) == 1 {
		return found[0]
	}
	return ""
}

// ErrChecksum is returned when the download does not match a published SHA-256.
var ErrChecksum = errors.New("SHA-256 mismatch")

// Download fetches asset into destFile, enforcing MaxZipSize, and checks it against every expected hash.
// Returns the SHA-256 (hex) of the file.
func (c *Client) Download(ctx context.Context, asset *Asset, destFile string, expected []Expected) (string, error) {
	if asset.Size > MaxZipSize {
		return "", fmt.Errorf("asset too large (%d bytes)", asset.Size)
	}
	resp, err := c.get(ctx, asset.URL, "application/octet-stream")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	f, err := os.Create(destFile)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, MaxZipSize+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", fmt.Errorf("downloading %s: %w", asset.Name, err)
	}
	if n > MaxZipSize {
		return "", fmt.Errorf("asset larger than %d bytes", MaxZipSize)
	}
	if asset.Size > 0 && n != asset.Size {
		return "", fmt.Errorf("downloaded %d bytes, expected %d", n, asset.Size)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if err := Verify(sum, expected); err != nil {
		return sum, err
	}
	return sum, nil
}

// Verify checks sum against every expected hash.
func Verify(sum string, expected []Expected) error {
	for _, e := range expected {
		if !strings.EqualFold(sum, e.SHA256) {
			return fmt.Errorf("%w: got %s, %s says %s", ErrChecksum, sum, e.Source, e.SHA256)
		}
	}
	return nil
}

// FileSHA256 hashes a local file.
func FileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
