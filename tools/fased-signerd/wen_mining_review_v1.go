package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

type wenMiningReviewV1 struct {
	Version         int                     `json:"version"`
	WalletID        string                  `json:"walletId"`
	WalletPublicKey string                  `json:"walletPublicKey"`
	Intent          signerWENMiningIntentV1 `json:"intent"`
	Pins            wenMiningPinsV1         `json:"pins"`
	MaxSlotLag      uint64                  `json:"maxSlotLag"`
}

// Flat, hash-scoped files preserve protected parent checks and allow concurrent tasks.
func wenMiningAdmissionNameV2(v signerWENMiningIntentV1) string {
	return "admission-" + wenHashV1([]byte(v.Genesis+":"+v.ProgramID+":"+v.Economy+":"+v.Entry+":"+v.Operation)) + ".json"
}

func loadWENMiningReviewV1(dbPath, walletID string, v signerWENMiningIntentV1) (wenMiningExecutionConfigV1, solana.PublicKey, error) {
	var config wenMiningExecutionConfigV1
	var wallet solana.PublicKey
	bad := errors.New("protected mining review unavailable or mismatched")
	if !filepath.IsAbs(dbPath) || filepath.Clean(dbPath) != dbPath || walletID == "" || normalizeWalletID(walletID) != walletID || validateWENMiningIntentV1(v) != nil {
		return config, wallet, bad
	}
	root := filepath.Join(filepath.Dir(dbPath), "wen-mining", wenHashV1([]byte(walletID)))
	if e := checkWENMiningRootV1(root, filepath.Dir(dbPath)); e != nil {
		return config, wallet, bad
	}
	path := filepath.Join(root, wenMiningAdmissionNameV2(v))
	version := 2
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		path = filepath.Join(root, "admission.json")
		version = 1
	} else if err != nil {
		return config, wallet, bad
	}
	raw, e := readSignerAdminJSONFile(path, 16384)
	if e != nil {
		return config, wallet, bad
	}
	var review wenMiningReviewV1
	if decodeStrictJSONV2(raw, &review) != nil || review.Version != version || review.WalletID != walletID || review.Intent != v {
		return config, wallet, bad
	}
	wallet, e = solana.PublicKeyFromBase58(review.WalletPublicKey)
	if e != nil || wallet.IsZero() || wallet.String() != review.WalletPublicKey {
		return config, solana.PublicKey{}, bad
	}
	p := review.Pins
	minimum, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	if p.ProgramID != v.ProgramID || p.Genesis != v.Genesis || p.DescriptorSHA256 != v.DescriptorSHA256 || p.CapabilitySHA256 != v.CapabilitySHA256 || !wenReservationHashV1(p.CodeSHA256) || p.DeploymentSlot == 0 || p.DeploymentSlot > minimum || p.UpgradeAuthority != nil && p.UpgradeAuthority.IsZero() {
		return config, wallet, bad
	}
	canonical, _ := json.Marshal(review)
	return wenMiningExecutionConfigV1{Root: root, RequireLaunchBudget: version == 2, Pins: p, MaxSlotLag: review.MaxSlotLag, reviewSHA: wenHashV1(canonical)}, wallet, nil
}

func (s *signerServiceV2) executeReviewedWENMiningV1(ctx context.Context, client wenMiningExecutionRPCV1, request, walletID, policyHash string, v signerWENMiningIntentV1) (string, string, error) {
	if s == nil || s.store == nil {
		return "", "", errors.New("mining service unavailable")
	}
	config, wallet, e := loadWENMiningReviewV1(s.store.db.Path(), walletID, v)
	if e != nil {
		return "", "", e
	}
	return s.executeWENMiningWithRPCV1(ctx, client, config, request, walletID, policyHash, v, wallet)
}

func checkWENMiningRootV1(root, parent string) error {
	bad := errors.New("unprotected mining root")
	for dir := root; ; dir = filepath.Dir(dir) {
		info, e := os.Lstat(dir)
		if e != nil {
			return bad
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) {
			return bad
		}
		if dir == parent {
			break
		}
	}

	return nil
}
