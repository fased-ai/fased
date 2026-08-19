package platform

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/model"
)

const (
	taskLedgerQuiesceSchema         = 1
	taskLedgerQuiesceCapabilityFile = ".task-ledger-quiesce-capability-v1.json"
	taskLedgerQuiesceRequestFile    = ".task-ledger-quiesce-request-v1.json"
	taskLedgerQuiesceAckFile        = ".task-ledger-quiesce-ack-v1.json"
	taskLedgerQuiesceIntentFile     = "task-ledger-quiesce-intent.json"
)

type taskLedgerQuiesceEnvelope struct {
	Schema        int    `json:"schema"`
	TransactionID string `json:"transactionId"`
	Nonce         string `json:"nonce"`
}

type taskLedgerQuiesceIntent struct {
	Schema        int    `json:"schema"`
	TransactionID string `json:"transactionId"`
	Mode          string `json:"mode"`
	Nonce         string `json:"nonce,omitempty"`
}

type taskLedgerQuiesceReceipt struct {
	Schema                 int    `json:"schema"`
	TransactionID          string `json:"transactionId"`
	Mode                   string `json:"mode"`
	Nonce                  string `json:"nonce,omitempty"`
	AckDigest              string `json:"ackDigest,omitempty"`
	ApplicationStateDigest string `json:"applicationStateDigest,omitempty"`
}

// TaskLedgerQuiescer is the Go-owned transaction handshake for the managed
// task SQLite ledger. A missing capability marker deliberately selects the
// legacy typed-state bridge so old predecessors remain adoptable.
type TaskLedgerQuiescer struct {
	Config     Config
	rootPrefix string
}

func NewTaskLedgerQuiescer(config Config) *TaskLedgerQuiescer {
	return &TaskLedgerQuiescer{Config: config}
}

func (quiescer *TaskLedgerQuiescer) Begin(tx model.Transaction) error {
	if quiescer == nil || tx.ID == "" {
		return errors.New("task ledger quiesce transaction is invalid")
	}
	marker, found, err := quiescer.readExact(quiescer.capabilityPath())
	if err != nil {
		return err
	}
	if !found {
		return quiescer.writeAtomicNew(quiescer.intentPath(tx), canonicalQuiesceIntent(taskLedgerQuiesceIntent{
			Schema: taskLedgerQuiesceSchema, TransactionID: tx.ID, Mode: "legacy-typed-state-bridge",
		}), 0o600)
	}
	// The capability marker itself is canonical and persistent. Its presence,
	// not a release name, requires an acknowledgement from this predecessor.
	if string(marker) != "{\"schema\":1,\"capability\":\"task-ledger-quiesce-v1\"}\n" {
		return errors.New("task ledger quiesce capability marker is invalid")
	}
	if _, found, err := quiescer.readExact(quiescer.requestPath()); err != nil || found {
		if err != nil {
			return err
		}
		return errors.New("task ledger quiesce request collision")
	}
	if _, found, err := quiescer.readExact(quiescer.ackPath()); err != nil || found {
		if err != nil {
			return err
		}
		return errors.New("task ledger quiesce acknowledgement collision")
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	requestPath := quiescer.requestPath()
	if err := quiescer.writeAtomicNew(requestPath, canonicalQuiesceEnvelope(taskLedgerQuiesceEnvelope{
		Schema: taskLedgerQuiesceSchema, TransactionID: tx.ID, Nonce: hex.EncodeToString(nonce),
	}), 0o600); err != nil {
		return err
	}
	// The lifecycle daemon writes as root, but the isolated Gateway must read
	// this non-secret nonce request to create its acknowledgement. Unit tests
	// run unprivileged and therefore retain their own test owner.
	if os.Geteuid() == 0 {
		if err := os.Chown(requestPath, int(quiescer.Config.Gateway.UID), int(quiescer.Config.Gateway.GID)); err != nil {
			return err
		}
		file, err := os.Open(requestPath)
		if err != nil {
			return err
		}
		err = file.Sync()
		file.Close()
		if err != nil {
			return err
		}
		if err := syncDirectory(filepath.Dir(requestPath)); err != nil {
			return err
		}
	}
	return quiescer.writeAtomicNew(quiescer.intentPath(tx), canonicalQuiesceIntent(taskLedgerQuiesceIntent{
		Schema: taskLedgerQuiesceSchema, TransactionID: tx.ID, Mode: "acknowledgement-required", Nonce: hex.EncodeToString(nonce),
	}), 0o600)
}

// Complete validates the post-stop acknowledgement when Begin created a
// request. Otherwise it records the explicit legacy typed-state bridge.
func (quiescer *TaskLedgerQuiescer) Complete(tx model.Transaction) error {
	if completed, err := quiescer.existingReceipt(tx); err != nil {
		return err
	} else if completed {
		return quiescer.Abort(tx)
	}
	intentData, intended, err := quiescer.readExact(quiescer.intentPath(tx))
	if err != nil {
		return err
	}
	if !intended {
		return errors.New("task ledger quiesce intent is missing")
	}
	intent, err := parseQuiesceIntent(intentData)
	if err != nil || intent.TransactionID != tx.ID {
		return errors.New("task ledger quiesce intent does not match transaction")
	}
	request, requested, err := quiescer.readExact(quiescer.requestPath())
	if err != nil {
		return err
	}
	var ack []byte
	var found bool
	receipt := taskLedgerQuiesceReceipt{Schema: taskLedgerQuiesceSchema, TransactionID: tx.ID}
	switch intent.Mode {
	case "acknowledgement-required":
		if !requested {
			return errors.New("task ledger quiesce request is missing for capable predecessor")
		}
		envelope, err := parseQuiesceEnvelope(request)
		if err != nil || envelope.TransactionID != tx.ID || envelope.Nonce != intent.Nonce {
			return errors.New("task ledger quiesce request does not match transaction")
		}
		ack, found, err = quiescer.readExact(quiescer.ackPath())
		if err != nil || !found {
			if err != nil {
				return err
			}
			return errors.New("task ledger quiesce acknowledgement is missing")
		}
		acknowledgement, err := parseQuiesceEnvelope(ack)
		if err != nil || acknowledgement != envelope || string(ack) != string(canonicalQuiesceEnvelope(envelope)) {
			return errors.New("task ledger quiesce acknowledgement is invalid or stale")
		}
		digest := sha256.Sum256(ack)
		receipt.Mode, receipt.Nonce, receipt.AckDigest = "acknowledged", envelope.Nonce, fmt.Sprintf("sha256:%x", digest)
	case "legacy-typed-state-bridge":
		if requested {
			return errors.New("legacy task ledger quiesce bridge has an unexpected request")
		}
		if _, acknowledged, err := quiescer.readExact(quiescer.ackPath()); err != nil || acknowledged {
			if err != nil {
				return err
			}
			return errors.New("legacy task ledger quiesce bridge has an unexpected acknowledgement")
		}
		receipt.Mode = "legacy-typed-state-bridge"
	default:
		return errors.New("task ledger quiesce intent mode is invalid")
	}
	if err := quiescer.writeAtomic(quiescer.receiptPath(tx), canonicalQuiesceReceipt(receipt), 0o600); err != nil {
		return err
	}
	if intent.Mode == "acknowledgement-required" {
		// Clear acknowledgement first. If an interruption occurs between the
		// removals, the remaining request still proves this was a capable
		// predecessor and can never be mistaken for the legacy bridge.
		if err := quiescer.removeExactData(quiescer.ackPath(), ack); err != nil {
			return err
		}
		if err := quiescer.removeExactData(quiescer.requestPath(), request); err != nil {
			return err
		}
	}
	return nil
}

// Abort removes only the exact transaction-bound transient handshake files.
// It is safe to call after a failed quiesce or completion: no files means no
// work, but malformed, stale, or mismatched evidence remains fail-closed for
// manual inspection instead of being silently erased.
func (quiescer *TaskLedgerQuiescer) Abort(tx model.Transaction) error {
	if quiescer == nil || tx.ID == "" {
		return errors.New("task ledger quiesce transaction is invalid")
	}
	request, requested, err := quiescer.readExact(quiescer.requestPath())
	if err != nil {
		return err
	}
	ack, acknowledged, err := quiescer.readExact(quiescer.ackPath())
	if err != nil {
		return err
	}
	if !requested && !acknowledged {
		return nil
	}
	if !requested {
		return errors.New("task ledger quiesce acknowledgement has no request")
	}
	envelope, err := parseQuiesceEnvelope(request)
	if err != nil || envelope.TransactionID != tx.ID {
		return errors.New("task ledger quiesce request does not match transaction")
	}
	if acknowledged {
		acknowledgement, err := parseQuiesceEnvelope(ack)
		if err != nil || acknowledgement != envelope || !bytes.Equal(ack, canonicalQuiesceEnvelope(envelope)) {
			return errors.New("task ledger quiesce acknowledgement is invalid or stale")
		}
		if err := quiescer.removeExactData(quiescer.ackPath(), ack); err != nil {
			return err
		}
	}
	return quiescer.removeExactData(quiescer.requestPath(), request)
}

// BindStateCapture closes the legacy bridge only after typed state captured
// the exact task SQLite family. The returned digest is durable receipt bytes.
func (quiescer *TaskLedgerQuiescer) BindStateCapture(tx model.Transaction, applicationStateDigest string) (string, error) {
	if !validDigest(applicationStateDigest) {
		return "", errors.New("task ledger typed-state digest is invalid")
	}
	data, found, err := quiescer.readExact(quiescer.receiptPath(tx))
	if err != nil || !found {
		if err != nil {
			return "", err
		}
		return "", errors.New("task ledger quiesce receipt is missing")
	}
	var receipt taskLedgerQuiesceReceipt
	if err := json.Unmarshal(data, &receipt); err != nil || receipt.Schema != taskLedgerQuiesceSchema || receipt.TransactionID != tx.ID || (receipt.Mode != "acknowledged" && receipt.Mode != "legacy-typed-state-bridge") || receipt.ApplicationStateDigest != "" {
		return "", errors.New("task ledger quiesce receipt is invalid")
	}
	receipt.ApplicationStateDigest = applicationStateDigest
	data = canonicalQuiesceReceipt(receipt)
	if err := quiescer.writeAtomic(quiescer.receiptPath(tx), data, 0o600); err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return fmt.Sprintf("sha256:%x", digest), nil
}

func canonicalQuiesceEnvelope(value taskLedgerQuiesceEnvelope) []byte {
	data, _ := json.Marshal(value)
	return append(data, '\n')
}

func canonicalQuiesceIntent(value taskLedgerQuiesceIntent) []byte {
	data, _ := json.Marshal(value)
	return append(data, '\n')
}

func canonicalQuiesceReceipt(value taskLedgerQuiesceReceipt) []byte {
	data, _ := json.Marshal(value)
	return append(data, '\n')
}

func parseQuiesceEnvelope(data []byte) (taskLedgerQuiesceEnvelope, error) {
	var value taskLedgerQuiesceEnvelope
	if err := json.Unmarshal(data, &value); err != nil || value.Schema != taskLedgerQuiesceSchema || !validTransactionID(value.TransactionID) || len(value.Nonce) != 64 || strings.Trim(value.Nonce, "0123456789abcdef") != "" || string(data) != string(canonicalQuiesceEnvelope(value)) {
		return taskLedgerQuiesceEnvelope{}, errors.New("task ledger quiesce envelope is invalid")
	}
	return value, nil
}

func parseQuiesceIntent(data []byte) (taskLedgerQuiesceIntent, error) {
	var value taskLedgerQuiesceIntent
	if err := json.Unmarshal(data, &value); err != nil || value.Schema != taskLedgerQuiesceSchema || !validTransactionID(value.TransactionID) || (value.Mode != "acknowledgement-required" && value.Mode != "legacy-typed-state-bridge") || (value.Mode == "acknowledgement-required" && (len(value.Nonce) != 64 || strings.Trim(value.Nonce, "0123456789abcdef") != "")) || (value.Mode == "legacy-typed-state-bridge" && value.Nonce != "") || string(data) != string(canonicalQuiesceIntent(value)) {
		return taskLedgerQuiesceIntent{}, errors.New("task ledger quiesce intent is invalid")
	}
	return value, nil
}

func validTransactionID(value string) bool {
	return len(value) > 0 && len(value) <= 128 && strings.IndexFunc(value, func(r rune) bool {
		return !(r == '.' || r == '_' || r == '-' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
	}) < 0
}

func (quiescer *TaskLedgerQuiescer) tasksRoot() string {
	return quiescer.resolve(filepath.Join(quiescer.Config.OwnerStateRoot, "tasks"))
}
func (quiescer *TaskLedgerQuiescer) capabilityPath() string {
	return filepath.Join(quiescer.tasksRoot(), taskLedgerQuiesceCapabilityFile)
}
func (quiescer *TaskLedgerQuiescer) requestPath() string {
	return filepath.Join(quiescer.tasksRoot(), taskLedgerQuiesceRequestFile)
}
func (quiescer *TaskLedgerQuiescer) ackPath() string {
	return filepath.Join(quiescer.tasksRoot(), taskLedgerQuiesceAckFile)
}
func (quiescer *TaskLedgerQuiescer) intentPath(tx model.Transaction) string {
	return quiescer.resolve(filepath.Join(quiescer.Config.LifecycleRoot, "transactions", tx.ID, "target", taskLedgerQuiesceIntentFile))
}
func (quiescer *TaskLedgerQuiescer) receiptPath(tx model.Transaction) string {
	return quiescer.resolve(filepath.Join(quiescer.Config.LifecycleRoot, "transactions", tx.ID, "target", "task-ledger-quiesce.json"))
}
func (quiescer *TaskLedgerQuiescer) resolve(path string) string {
	if quiescer.rootPrefix == "" {
		return path
	}
	return filepath.Join(quiescer.rootPrefix, filepath.Clean(path))
}

func (quiescer *TaskLedgerQuiescer) readExact(path string) ([]byte, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || stat.Nlink != 1 || info.Mode().Perm()&0o007 != 0 || info.Mode().Perm()&0o111 != 0 || info.Size() > 4096 {
		return nil, false, errors.New("task ledger quiesce file is unsafe")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, after) || after.Size() != info.Size() {
		return nil, false, errors.New("task ledger quiesce file changed while reading")
	}
	return data, true, nil
}

func (quiescer *TaskLedgerQuiescer) existingReceipt(tx model.Transaction) (bool, error) {
	data, found, err := quiescer.readExact(quiescer.receiptPath(tx))
	if err != nil || !found {
		return false, err
	}
	var receipt taskLedgerQuiesceReceipt
	if err := json.Unmarshal(data, &receipt); err != nil || receipt.Schema != taskLedgerQuiesceSchema || receipt.TransactionID != tx.ID || (receipt.Mode != "acknowledged" && receipt.Mode != "legacy-typed-state-bridge") || string(data) != string(canonicalQuiesceReceipt(receipt)) {
		return false, errors.New("task ledger quiesce receipt is invalid")
	}
	return true, nil
}

func (quiescer *TaskLedgerQuiescer) writeAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".fased-task-ledger-quiesce-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

// writeAtomicNew publishes by hard link rather than rename, so a second
// writer cannot replace a destination created after a collision pre-check.
func (quiescer *TaskLedgerQuiescer) writeAtomicNew(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".fased-task-ledger-quiesce-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryPath, path); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func (quiescer *TaskLedgerQuiescer) removeExact(path string) error {
	if _, found, err := quiescer.readExact(path); err != nil {
		return err
	} else if !found {
		return errors.New("task ledger quiesce transient is missing")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func (quiescer *TaskLedgerQuiescer) removeExactData(path string, expected []byte) error {
	actual, found, err := quiescer.readExact(path)
	if err != nil {
		return err
	}
	if !found || !bytes.Equal(actual, expected) {
		return errors.New("task ledger quiesce transient changed before removal")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
