package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

type wenWithdrawalReviewV1 struct {
	Version              int                         `json:"version"`
	WalletID             string                      `json:"walletId"`
	WalletPublicKey      string                      `json:"walletPublicKey"`
	Intent               signerWENWithdrawalIntentV1 `json:"intent"`
	Pins                 wenStakingPinsV1            `json:"pins"`
	MaxTotalCostLamports uint64                      `json:"maxTotalCostLamports"`
	MaxSlotLag           uint64                      `json:"maxSlotLag"`
}

// Full-intent scoping keeps independent pending requests and launches separate.
func wenWithdrawalAdmissionNameV1(v signerWENWithdrawalIntentV1) string {
	raw, _ := json.Marshal(v)
	return "admission-" + wenHashV1(raw) + ".json"
}

// Private configuration; not proof of RPC state, capability semantics or signing permission.
type wenWithdrawalReviewedConfigV1 struct {
	root                 string
	pins                 wenStakingPinsV1
	maxSlotLag           uint64
	maxTotalCostLamports uint64
	reviewSHA            string
}

func loadWENWithdrawalReviewV1(dbPath, walletID string, v signerWENWithdrawalIntentV1) (wenWithdrawalReviewedConfigV1, solana.PublicKey, error) {
	var config wenWithdrawalReviewedConfigV1
	var wallet solana.PublicKey
	bad := errors.New("protected withdrawal review unavailable or mismatched")
	if !filepath.IsAbs(dbPath) || filepath.Clean(dbPath) != dbPath || walletID == "" || normalizeWalletID(walletID) != walletID || validateWENWithdrawalIntentV1(v) != nil {
		return config, wallet, bad
	}
	root := filepath.Join(filepath.Dir(dbPath), "wen-withdrawal", wenHashV1([]byte(walletID)))
	for dir := root; ; dir = filepath.Dir(dir) {
		info, e := os.Lstat(dir)
		if e != nil {
			return config, wallet, bad
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) {
			return config, wallet, bad
		}
		if dir == filepath.Dir(dbPath) {
			break
		}
	}
	path := filepath.Join(root, wenWithdrawalAdmissionNameV1(v))

	raw, e := readSignerAdminJSONFile(path, 16384)
	if e != nil {
		return config, wallet, bad
	}
	var review wenWithdrawalReviewV1
	if decodeStrictJSONV2(raw, &review) != nil || review.Version != 1 || review.WalletID != walletID || review.Intent != v {
		return config, wallet, bad
	}
	wallet, e = solana.PublicKeyFromBase58(review.WalletPublicKey)
	if e != nil || wallet.IsZero() || wallet.String() != review.WalletPublicKey {
		return config, solana.PublicKey{}, bad
	}
	if _, e := buildWENWithdrawalInstructionV1(v, wallet); e != nil {
		return config, wallet, bad
	}
	fee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if review.MaxTotalCostLamports < fee {
		return config, wallet, bad
	}
	p := review.Pins
	minimum, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	if p.ProgramID != v.ProgramID || p.Genesis != v.Genesis || p.DescriptorSHA256 != v.DescriptorSHA256 || p.CapabilitySHA256 != v.CapabilitySHA256 || !wenReservationHashV1(p.CodeSHA256) || p.DeploymentSlot == 0 || p.DeploymentSlot > minimum || p.UpgradeAuthority != nil && p.UpgradeAuthority.IsZero() {
		return config, wallet, bad
	}
	canonical, _ := json.Marshal(review)
	return wenWithdrawalReviewedConfigV1{root: root, pins: p, maxSlotLag: review.MaxSlotLag, maxTotalCostLamports: review.MaxTotalCostLamports, reviewSHA: wenHashV1(canonical)}, wallet, nil
}

// Re-read before reservation/signing; changed review bytes require a fresh preparation.
func recheckWENWithdrawalReviewV1(dbPath, walletID string, v signerWENWithdrawalIntentV1, expected wenWithdrawalReviewedConfigV1, owner solana.PublicKey) error {
	current, wallet, err := loadWENWithdrawalReviewV1(dbPath, walletID, v)
	if err != nil {
		return err
	}
	if wallet != owner || current.reviewSHA != expected.reviewSHA || current.root != expected.root || current.maxSlotLag != expected.maxSlotLag || current.maxTotalCostLamports != expected.maxTotalCostLamports {
		return errors.New("withdrawal protected review changed")
	}
	a, _ := json.Marshal(current.pins)
	b, _ := json.Marshal(expected.pins)
	if string(a) != string(b) {
		return errors.New("withdrawal protected pins changed")
	}
	return nil
}
