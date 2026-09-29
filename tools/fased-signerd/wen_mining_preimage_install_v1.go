package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"syscall"
)

type wenMiningPreimageInstallV1 struct {
	Intent   signerWENMiningIntentV1 `json:"intent"`
	Preimage wenMiningPreimageV1     `json:"preimage"`
}
type wenMiningPreimageReceiptV1 struct {
	Status           string `json:"status"`
	WalletID         string `json:"walletId"`
	PreimageKey      string `json:"preimageKey"`
	CommitmentSHA256 string `json:"commitmentSha256"`
	SigningEnabled   bool   `json:"signingEnabled"`
}

// Import exact client-generated material over owner control only. No generation,
// replacement, chain mutation or signing permission is implicit in this operation.
func (s *signerServiceV2) installMiningPreimageV1(ctx context.Context, cfg signerConfig, walletID string, body wenMiningPreimageInstallV1, control bool) (wenMiningPreimageReceiptV1, error) {
	var out wenMiningPreimageReceiptV1
	bad := errors.New("mining preimage installation rejected")
	if e := requireControlSocketV2(control); e != nil {
		return out, e
	}
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || !filepath.IsAbs(cfg.stateDBPath) || filepath.Clean(cfg.stateDBPath) != cfg.stateDBPath {
		return out, bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return out, e
	}
	v := body.Intent
	if walletID == "" || normalizeWalletID(walletID) != walletID || v.Operation != "commit" || validateWENMiningIntentV1(v) != nil {
		return out, bad
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil {
		return out, bad
	}
	wallet, e := solana.PublicKeyFromBase58(record.PublicKey)
	if e != nil {
		return out, bad
	}
	raw, e := json.Marshal(body.Preimage)
	if e != nil {
		return out, bad
	}
	defer zeroBytes(raw)
	material, e := validateWENMiningPreimageV1(raw, v, wallet)
	if e != nil {
		return out, e
	}
	defer zeroBytes(material)
	parent := filepath.Dir(cfg.stateDBPath)
	if e = checkWENMiningRootV1(parent, parent); e != nil {
		return out, e
	}
	root := parent
	for _, name := range []string{"wen-mining", wenHashV1([]byte(walletID))} {
		root = filepath.Join(root, name)
		if e = os.Mkdir(root, 0700); e != nil && !os.IsExist(e) {
			return out, e
		}
		if e = checkWENMiningRootV1(root, parent); e != nil {
			return out, e
		}
		if e = syncWENBTCDirectoryV1(filepath.Dir(root)); e != nil {
			return out, e
		}
	}
	info, e := os.Lstat(root)
	if e != nil || info.Mode().Perm() != 0700 {
		return out, bad
	}
	lock, e := acquireSignerEnrollmentLock(filepath.Join(root, ".mining-review-install.lock"))
	if e != nil {
		return out, e
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	if e = ctx.Err(); e != nil {
		return out, e
	}
	latest, e := s.keys.PublicRecord(walletID)
	if e != nil || latest.PublicKey != record.PublicKey {
		return out, bad
	}
	key := wenMiningPreimageKeyV1(v, wallet)
	if e = publishWENMiningObjectV1(root, key+".json", raw); e != nil {
		return out, e
	}
	confirmed, e := loadWENMiningPreimageV1(root, v, wallet)
	if e != nil {
		return out, e
	}
	zeroBytes(confirmed)
	return wenMiningPreimageReceiptV1{Status: "preimage-installed", WalletID: walletID, PreimageKey: key, CommitmentSHA256: v.CommitmentSHA256}, nil
}
func (s *signerServiceV2) installMiningPreimageServiceV1(req request, cfg signerConfig, control bool) ([]byte, error) {
	if e := requireControlSocketV2(control); e != nil {
		return nil, e
	}
	defer zeroBytes(req.Request)
	if len(req.Request) > 8192 {
		return nil, errors.New("mining preimage request too large")
	}
	var body wenMiningPreimageInstallV1
	if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
		return nil, errors.New("invalid mining preimage request")
	}
	out, e := s.installMiningPreimageV1(context.Background(), cfg, req.WalletID, body, control)
	if e != nil {
		return nil, e
	}
	return marshalSignerResultV2(out)
}
