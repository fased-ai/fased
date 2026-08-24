package publicupdate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

const (
	SchemaVersion      uint32 = 1
	maxEnvelopeBytes          = 64 << 10
	maxReceiptBytes           = 8 << 10
	HostingReceiptPath        = "/var/lib/fased-bootstrap/hosting-authority-v1.json"
)

var (
	accountPattern = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	hexDigest      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	digestID       = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// Request is the permanent Stage-0-to-target-host Hosting update envelope.
// Evolving platform, manifest, plugin, onboarding, and hardening state is
// deliberately absent and belongs only to the acquired lifecycle host.
type Request struct {
	SchemaVersion            uint32        `json:"schemaVersion"`
	Operation                string        `json:"operation"`
	Profile                  model.Profile `json:"profile"`
	Channel                  string        `json:"channel"`
	Version                  string        `json:"version"`
	OperatorUser             string        `json:"operatorUser"`
	GatewayPort              uint16        `json:"gatewayPort"`
	PlatformIdentity         string        `json:"platformIdentity"`
	TimeoutSeconds           uint32        `json:"timeoutSeconds"`
	TrustRootSHA256          string        `json:"trustRootSha256"`
	HostDigest               string        `json:"hostDigest"`
	ApplicationPath          string        `json:"applicationPath"`
	DependencyPath           string        `json:"dependencyPath,omitempty"`
	ReleaseSequence          uint64        `json:"releaseSequence"`
	SecurityEpoch            uint64        `json:"securityEpoch"`
	ManifestProtocolMin      uint32        `json:"manifestProtocolMin"`
	ManifestProtocolMax      uint32        `json:"manifestProtocolMax"`
	ReleaseIndexDigest       string        `json:"releaseIndexDigest"`
	ReleaseAuthorityDigest   string        `json:"releaseAuthorityDigest"`
	PluginLockDigest         string        `json:"pluginLockDigest"`
	ExpectedPreviousSequence uint64        `json:"expectedPreviousSequence"`
	ExpectedPreviousEpoch    uint64        `json:"expectedPreviousEpoch"`
}

func (request Request) Validate() error {
	if request.SchemaVersion != SchemaVersion || (request.Operation != "update" && request.Operation != "repair") ||
		request.Profile != model.ProfileHosting || (request.Channel != "stable" && request.Channel != "beta") ||
		model.ValidateVersion(request.Version) != nil || !accountPattern.MatchString(request.OperatorUser) || request.OperatorUser == "root" ||
		request.GatewayPort == 0 || request.PlatformIdentity != "linux/x64" || request.TimeoutSeconds == 0 || request.TimeoutSeconds > 600 ||
		!hexDigest.MatchString(request.TrustRootSHA256) || !hexDigest.MatchString(request.HostDigest) ||
		!safeAbsolutePath(request.ApplicationPath) || (request.DependencyPath != "" && !safeAbsolutePath(request.DependencyPath)) ||
		request.ReleaseSequence == 0 || request.SecurityEpoch == 0 || request.ManifestProtocolMin == 0 ||
		request.ManifestProtocolMax < request.ManifestProtocolMin || !digestID.MatchString(request.ReleaseIndexDigest) ||
		!digestID.MatchString(request.ReleaseAuthorityDigest) || !digestID.MatchString(request.PluginLockDigest) ||
		request.ExpectedPreviousSequence == 0 || request.ExpectedPreviousEpoch == 0 ||
		request.ReleaseSequence < request.ExpectedPreviousSequence || request.SecurityEpoch < request.ExpectedPreviousEpoch {
		return errors.New("public Hosting update envelope is invalid")
	}
	if strings.Contains(request.Version, "-") != (request.Channel == "beta") {
		return errors.New("public Hosting update version differs from its channel")
	}
	if request.Operation == "repair" && request.ReleaseSequence != request.ExpectedPreviousSequence {
		return errors.New("public Hosting repair cannot select a different release")
	}
	return nil
}

func DecodeRequest(reader io.Reader) (Request, error) {
	decoder := json.NewDecoder(io.LimitReader(reader, maxEnvelopeBytes+1))
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		return Request{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Request{}, errors.Join(err, errors.New("public Hosting update envelope contains trailing data"))
	}
	if err := request.Validate(); err != nil {
		return Request{}, err
	}
	return request, nil
}

// Receipt is the only installed state Stage-0 may interpret. Its schema and
// location are permanent; all evolving state remains lifecycle-host-owned.
type Receipt struct {
	SchemaVersion            uint32        `json:"schemaVersion"`
	Profile                  model.Profile `json:"profile"`
	Channel                  string        `json:"channel"`
	Version                  string        `json:"version"`
	OperatorUser             string        `json:"operatorUser"`
	GatewayPort              uint16        `json:"gatewayPort"`
	PlatformIdentity         string        `json:"platformIdentity"`
	ReleaseSequence          uint64        `json:"releaseSequence"`
	SecurityEpoch            uint64        `json:"securityEpoch"`
	ActiveGenerationID       string        `json:"activeGenerationId"`
	ConvergenceReceiptDigest string        `json:"convergenceReceiptDigest"`
}

func (receipt Receipt) Validate() error {
	if receipt.SchemaVersion != SchemaVersion || receipt.Profile != model.ProfileHosting ||
		(receipt.Channel != "stable" && receipt.Channel != "beta") || model.ValidateVersion(receipt.Version) != nil ||
		!accountPattern.MatchString(receipt.OperatorUser) || receipt.OperatorUser == "root" || receipt.GatewayPort == 0 ||
		receipt.PlatformIdentity != "linux/x64" || receipt.ReleaseSequence == 0 || receipt.SecurityEpoch == 0 ||
		!digestID.MatchString(receipt.ActiveGenerationID) || !digestID.MatchString(receipt.ConvergenceReceiptDigest) ||
		strings.Contains(receipt.Version, "-") != (receipt.Channel == "beta") {
		return errors.New("public Hosting authority receipt is invalid")
	}
	return nil
}

func ReadHostingReceipt() (Receipt, error) {
	return readHostingReceiptAt(HostingReceiptPath, 0, 0)
}

func readHostingReceiptAt(path string, expectedUID, expectedGID uint32) (Receipt, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Receipt{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 ||
		stat.Uid != expectedUID || stat.Gid != expectedGID || stat.Nlink != 1 || info.Size() <= 0 || info.Size() > maxReceiptBytes {
		return Receipt{}, errors.New("public Hosting authority receipt is unsafe")
	}
	descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return Receipt{}, err
	}
	file := os.NewFile(uintptr(descriptor), path)
	defer file.Close()
	var opened syscall.Stat_t
	if err := syscall.Fstat(descriptor, &opened); err != nil || opened.Dev != stat.Dev || opened.Ino != stat.Ino || opened.Uid != expectedUID || opened.Gid != expectedGID || opened.Nlink != 1 {
		return Receipt{}, errors.Join(err, errors.New("opened public Hosting authority receipt is unsafe"))
	}
	decoder := json.NewDecoder(io.LimitReader(file, maxReceiptBytes+1))
	decoder.DisallowUnknownFields()
	var receipt Receipt
	if err := decoder.Decode(&receipt); err != nil {
		return Receipt{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Receipt{}, errors.Join(err, errors.New("public Hosting authority receipt contains trailing data"))
	}
	if err := receipt.Validate(); err != nil {
		return Receipt{}, err
	}
	return receipt, nil
}

func WriteHostingReceipt(receipt Receipt) error {
	return writeHostingReceiptAt(HostingReceiptPath, receipt, 0, 0)
}

func writeHostingReceiptAt(path string, receipt Receipt, expectedUID, expectedGID uint32) error {
	if err := receipt.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	directory, err := os.Lstat(filepath.Dir(path))
	stat, ok := directoryStat(directory)
	if err != nil || !ok || !directory.IsDir() || directory.Mode()&os.ModeSymlink != 0 || directory.Mode().Perm() != 0o700 || stat.Uid != expectedUID || stat.Gid != expectedGID {
		return errors.Join(err, errors.New("public Hosting authority directory is unsafe"))
	}
	if _, err := os.Lstat(path); err == nil {
		if _, readErr := readHostingReceiptAt(path, expectedUID, expectedGID); readErr != nil {
			return readErr
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	data, err := json.Marshal(receipt)
	if err != nil || len(data) > maxReceiptBytes {
		return errors.Join(err, errors.New("public Hosting authority receipt exceeded its bound"))
	}
	replacement, err := platform.InstallFileTransactional(path, append(data, '\n'), 0o600, expectedUID, expectedGID)
	if err != nil {
		return err
	}
	replacement.Commit()
	return nil
}

func ExactReceipt(receipt Receipt, request Request) error {
	want := Receipt{SchemaVersion: SchemaVersion, Profile: request.Profile, Channel: request.Channel, Version: request.Version,
		OperatorUser: request.OperatorUser, GatewayPort: request.GatewayPort, PlatformIdentity: request.PlatformIdentity,
		ReleaseSequence: request.ReleaseSequence, SecurityEpoch: request.SecurityEpoch,
		ActiveGenerationID: receipt.ActiveGenerationID, ConvergenceReceiptDigest: receipt.ConvergenceReceiptDigest}
	left, _ := json.Marshal(receipt)
	right, _ := json.Marshal(want)
	if !bytes.Equal(left, right) {
		return fmt.Errorf("public Hosting authority receipt differs from the acquired release")
	}
	return nil
}

func ValidatePreviousReceipt(receipt Receipt, request Request) error {
	if err := receipt.Validate(); err != nil {
		return err
	}
	if err := request.Validate(); err != nil {
		return err
	}
	if receipt.Profile != request.Profile || receipt.OperatorUser != request.OperatorUser || receipt.GatewayPort != request.GatewayPort ||
		receipt.PlatformIdentity != request.PlatformIdentity || receipt.ReleaseSequence != request.ExpectedPreviousSequence ||
		receipt.SecurityEpoch != request.ExpectedPreviousEpoch {
		return errors.New("public Hosting update envelope differs from installed authority")
	}
	if request.Operation == "repair" && (request.Version != receipt.Version || request.Channel != receipt.Channel ||
		request.SecurityEpoch != receipt.SecurityEpoch) {
		return errors.New("public Hosting repair differs from installed authority")
	}
	return nil
}

func safeAbsolutePath(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value && value != "/" && !strings.ContainsAny(value, "\n\r\x00")
}

func directoryStat(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok
}
