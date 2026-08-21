package hostsecurity

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const maxStateBytes = 1 << 20

type Store struct {
	StatePath     string
	ReceiptPath   string
	OwnershipPath string
	UninstallPath string
	ExpectedUID   uint32
}

func (store Store) Validate() error {
	for _, path := range []string{store.StatePath, store.ReceiptPath, store.ownershipPath(), store.uninstallPath()} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
			return errors.New("Hosting security store path is unsafe")
		}
	}
	return nil
}

func (store Store) uninstallPath() string {
	if store.UninstallPath != "" {
		return store.UninstallPath
	}
	return filepath.Join(filepath.Dir(store.StatePath), "uninstall.json")
}

func (store Store) ownershipPath() string {
	if store.OwnershipPath != "" {
		return store.OwnershipPath
	}
	return filepath.Join(filepath.Dir(store.StatePath), "ownership.json")
}

func (store Store) EnsureOwnership(state State) (Ownership, error) {
	if current, err := store.ReadOwnership(); err == nil {
		if current.GatewayPort != state.GatewayPort || current.OperatorUser != state.OperatorUser {
			return Ownership{}, errors.New("Hosting ownership differs from the active platform")
		}
		return current, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return Ownership{}, err
	}
	ownership, err := ownershipFromCommittedState(state)
	if err != nil {
		return Ownership{}, err
	}
	data, err := json.Marshal(ownership)
	if err != nil {
		return Ownership{}, err
	}
	if err := writeAtomicRootFile(store.ownershipPath(), append(data, '\n'), 0o600, store.ExpectedUID); err != nil {
		return Ownership{}, err
	}
	return ownership, nil
}

func (store Store) ReadOwnership() (Ownership, error) {
	if err := store.Validate(); err != nil {
		return Ownership{}, err
	}
	data, err := readSecureRootFile(store.ownershipPath(), 0o600, store.ExpectedUID, maxStateBytes)
	if err != nil {
		return Ownership{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var ownership Ownership
	if err := decoder.Decode(&ownership); err != nil {
		return Ownership{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Ownership{}, errors.New("Hosting ownership contains trailing data")
	}
	if err := ownership.Validate(); err != nil {
		return Ownership{}, err
	}
	return ownership, nil
}

func (store Store) WriteUninstall(record UninstallRecord) error {
	if err := store.Validate(); err != nil {
		return err
	}
	if err := record.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return writeAtomicRootFile(store.uninstallPath(), append(data, '\n'), 0o600, store.ExpectedUID)
}

func (store Store) ReadUninstall() (UninstallRecord, error) {
	if err := store.Validate(); err != nil {
		return UninstallRecord{}, err
	}
	data, err := readSecureRootFile(store.uninstallPath(), 0o600, store.ExpectedUID, maxStateBytes)
	if err != nil {
		return UninstallRecord{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var record UninstallRecord
	if err := decoder.Decode(&record); err != nil {
		return UninstallRecord{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return UninstallRecord{}, errors.New("Hosting uninstall record contains trailing data")
	}
	if err := record.Validate(); err != nil {
		return UninstallRecord{}, err
	}
	return record, nil
}

func (store Store) WriteState(state State) error {
	if err := store.Validate(); err != nil {
		return err
	}
	if err := state.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return writeAtomicRootFile(store.StatePath, append(data, '\n'), 0o600, store.ExpectedUID)
}

func (store Store) ReadState() (State, error) {
	if err := store.Validate(); err != nil {
		return State{}, err
	}
	data, err := readSecureRootFile(store.StatePath, 0o600, store.ExpectedUID, maxStateBytes)
	if err != nil {
		return State{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var state State
	if err := decoder.Decode(&state); err != nil {
		return State{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return State{}, errors.New("Hosting security state contains trailing data")
	}
	if err := state.Validate(); err != nil {
		return State{}, err
	}
	return state, nil
}

func (store Store) WriteReceipt(state State, complete bool) error {
	if err := store.Validate(); err != nil {
		return err
	}
	if err := state.Validate(); err != nil || !state.RuntimeReady || state.TailscaleDNS == "" || !versionPattern.MatchString(state.TailscaleVersion) || !state.SignerWebAuthnChanged {
		return errors.New("Hosting security receipt state is incomplete")
	}
	ready := "pending"
	if complete {
		if state.Phase != PhaseCommitted || !state.HardeningCommitted || !state.AccessConfirmed {
			return errors.New("completed Hosting security receipt lacks committed authority")
		}
		ready = "true"
	}
	data := fmt.Sprintf("schemaVersion=3\nrelease=%s\nupdateChannel=%s\ntransactionId=%s\ngatewayPort=%d\ntailscaleDns=%s\ntailscaleVersion=%s\ntailscaleServeReady=true\nsignerWebAuthnReady=true\nfirewallReady=%s\nsshHardened=%s\nfail2banReady=%s\nautomaticUpdatesReady=%s\nsignerReady=true\nappSudoDisabled=true\npreparedBy=root\n",
		state.Release, state.Channel, state.TransactionID, state.GatewayPort, state.TailscaleDNS, state.TailscaleVersion, ready, ready, ready, ready)
	return writeAtomicRootFile(store.ReceiptPath, []byte(data), 0o644, store.ExpectedUID)
}

func (store Store) RemoveReceiptOwned(transactionID string) error {
	data, err := readRootReceiptForOwnership(store.ReceiptPath, store.ExpectedUID, 4096)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !bytes.Contains(data, []byte("transactionId="+transactionID+"\n")) {
		// A failed newer transaction must not remove the last committed receipt.
		return nil
	}
	return os.Remove(store.ReceiptPath)
}

func readRootReceiptForOwnership(path string, uid uint32, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, fmt.Errorf("Hosting security receipt %q lacks Unix metadata", path)
	}
	// Cleanup does not trust this content as a readiness receipt. It only looks
	// for the exact transaction ID before deletion, so a root-owned legacy mode
	// or empty placeholder may be inspected and preserved. Writable, linked,
	// foreign, non-regular, or oversized files remain fail-closed.
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uid ||
		stat.Nlink != 1 || info.Mode().Perm()&0o022 != 0 || info.Size() < 0 || info.Size() > limit {
		return nil, unsafeRootFileMetadataError("receipt", path, info, stat, uid,
			fmt.Sprintf("regular non-symlink uid=%d non-writable links=1 size=0..%d", uid, limit))
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.Join(err, fmt.Errorf("Hosting security receipt %q changed while opening", path))
	}
	return io.ReadAll(io.LimitReader(file, limit+1))
}

func readSecureRootFile(path string, mode os.FileMode, uid uint32, limit int64) ([]byte, error) {
	return readSecureRootFileRange(path, mode, uid, 1, limit)
}

func readSecureRootFileRange(path string, mode os.FileMode, uid uint32, minimum, limit int64) ([]byte, error) {
	if minimum < 0 || limit < minimum {
		return nil, errors.New("Hosting security root file size range is invalid")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, fmt.Errorf("Hosting security root file %q lacks Unix metadata", path)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != mode || stat.Uid != uid || stat.Nlink != 1 || info.Size() < minimum || info.Size() > limit {
		return nil, unsafeRootFileMetadataError("root file", path, info, stat, uid,
			fmt.Sprintf("regular non-symlink uid=%d mode=%04o links=1 size=%d..%d", uid, mode.Perm(), minimum, limit))
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.Join(err, fmt.Errorf("Hosting security root file %q changed while opening", path))
	}
	return io.ReadAll(io.LimitReader(file, limit+1))
}

func unsafeRootFileMetadataError(kind, path string, info os.FileInfo, stat *syscall.Stat_t, uid uint32, expected string) error {
	actualUID := uid
	links := uint64(0)
	if stat != nil {
		actualUID = stat.Uid
		links = stat.Nlink
	}
	return fmt.Errorf("Hosting security %s %q is unsafe: expected %s; got type=%s uid=%d mode=%04o links=%d size=%d",
		kind, path, expected, info.Mode().Type(), actualUID, info.Mode().Perm(), links, info.Size())
}

func writeAtomicRootFile(path string, data []byte, mode os.FileMode, uid uint32) error {
	if len(data) == 0 || mode.Perm()&0o022 != 0 {
		return errors.New("Hosting security atomic file input is unsafe")
	}
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uid || stat.Nlink != 1 {
			return errors.New("existing Hosting security file is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(parent, ".fased-host-security-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	remove := true
	defer func() {
		_ = temporary.Close()
		if remove {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(mode); err != nil {
		return err
	}
	if err := temporary.Chown(int(uid), int(uid)); err != nil {
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	remove = false
	directory, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
