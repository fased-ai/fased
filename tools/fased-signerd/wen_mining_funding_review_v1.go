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

type wenMiningFundingReviewV1 struct {
	Version              int                            `json:"version"`
	WalletID             string                         `json:"walletId"`
	WalletPublicKey      string                         `json:"walletPublicKey"`
	Intent               signerWENMiningFundingIntentV1 `json:"intent"`
	Pins                 wenStakingPinsV1               `json:"pins"`
	MaxTotalCostLamports uint64                         `json:"maxTotalCostLamports"`
	MaxSlotLag           uint64                         `json:"maxSlotLag"`
}

// Full-intent scoping keeps independent pending requests and launches separate.
func wenMiningFundingAdmissionNameV1(v signerWENMiningFundingIntentV1) string {
	raw, _ := json.Marshal(v)
	return "admission-" + wenHashV1(raw) + ".json"
}

// Private configuration; not proof of RPC state, capability semantics or signing permission.
type wenMiningFundingReviewedConfigV1 struct {
	root                 string
	pins                 wenStakingPinsV1
	maxSlotLag           uint64
	maxTotalCostLamports uint64
	reviewSHA            string
}

func loadWENMiningFundingReviewV1(dbPath, walletID string, v signerWENMiningFundingIntentV1) (wenMiningFundingReviewedConfigV1, solana.PublicKey, error) {
	var config wenMiningFundingReviewedConfigV1
	var wallet solana.PublicKey
	bad := errors.New("protected funding review unavailable or mismatched")
	if !filepath.IsAbs(dbPath) || filepath.Clean(dbPath) != dbPath || walletID == "" || normalizeWalletID(walletID) != walletID || validateWENMiningFundingIntentV1(v) != nil {
		return config, wallet, bad
	}
	root := filepath.Join(filepath.Dir(dbPath), "wen-mining-funding", wenHashV1([]byte(walletID)))
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
	path := filepath.Join(root, wenMiningFundingAdmissionNameV1(v))

	raw, e := readSignerAdminJSONFile(path, 16384)
	if e != nil {
		return config, wallet, bad
	}
	var review wenMiningFundingReviewV1
	if decodeStrictJSONV2(raw, &review) != nil || review.Version != 1 || review.WalletID != walletID || !equalWENMiningFundingIntentV1(review.Intent, v) {
		return config, wallet, bad
	}
	wallet, e = solana.PublicKeyFromBase58(review.WalletPublicKey)
	if e != nil || wallet.IsZero() || wallet.String() != review.WalletPublicKey {
		return config, solana.PublicKey{}, bad
	}
	if _, e := buildWENMiningFundingInstructionV1(v, wallet); e != nil {
		return config, wallet, bad
	}
	fee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if review.MaxTotalCostLamports < fee || review.MaxTotalCostLamports > signerNativeFeeReservationV2 {
		return config, wallet, bad
	}
	p := review.Pins
	minimum, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	if p.ProgramID != v.ProgramID || p.Genesis != v.Genesis || p.DescriptorSHA256 != v.DescriptorSHA256 || p.CapabilitySHA256 != v.CapabilitySHA256 || !wenReservationHashV1(p.CodeSHA256) || p.DeploymentSlot == 0 || p.DeploymentSlot > minimum || p.UpgradeAuthority != nil && p.UpgradeAuthority.IsZero() {
		return config, wallet, bad
	}
	canonical, _ := json.Marshal(review)
	return wenMiningFundingReviewedConfigV1{root: root, pins: p, maxSlotLag: review.MaxSlotLag, maxTotalCostLamports: review.MaxTotalCostLamports, reviewSHA: wenHashV1(canonical)}, wallet, nil
}

// Re-read before reservation/signing; changed review bytes require a fresh preparation.
func recheckWENMiningFundingReviewV1(dbPath, walletID string, v signerWENMiningFundingIntentV1, expected wenMiningFundingReviewedConfigV1, owner solana.PublicKey) error {
	current, wallet, err := loadWENMiningFundingAdmissionV1(dbPath, walletID, v)
	if err != nil {
		return err
	}
	if wallet != owner || current.reviewSHA != expected.reviewSHA || current.root != expected.root || current.maxSlotLag != expected.maxSlotLag || current.maxTotalCostLamports != expected.maxTotalCostLamports {
		return errors.New("funding protected review changed")
	}
	a, _ := json.Marshal(current.pins)
	b, _ := json.Marshal(expected.pins)
	if string(a) != string(b) {
		return errors.New("funding protected pins changed")
	}
	return nil
}

func equalWENMiningFundingIntentV1(a, b signerWENMiningFundingIntentV1) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// Only this composed loader establishes reviewed descriptor semantics. It does
// not reserve funds or authorize signing by itself.
func loadWENMiningFundingAdmissionV1(dbPath, walletID string, v signerWENMiningFundingIntentV1) (wenMiningFundingReviewedConfigV1, solana.PublicKey, error) {
	c, w, e := loadWENMiningFundingReviewV1(dbPath, walletID, v)
	if e != nil {
		return c, w, e
	}
	raw, e := readWENBTCObjectV1(c.root, c.pins.DescriptorSHA256, 32768)
	if e != nil {
		return c, w, e
	}
	if e = validateWENMiningFundingDescriptorV1(raw, c.pins); e != nil {
		return c, w, e
	}
	return c, w, nil
}

// Compose protected descriptor admission with finalized observation and recheck.
func readReviewedWENMiningFundingV1(ctx context.Context, dbPath, walletID string, v signerWENMiningFundingIntentV1, rpc signerWENBTCReadRPCV1) (wenMiningFundingReadbackV1, error) {
	var zero wenMiningFundingReadbackV1
	config, owner, e := loadWENMiningFundingAdmissionV1(dbPath, walletID, v)
	if e != nil {
		return zero, e
	}
	out, e := readWENMiningFundingRPCV1(ctx, rpc, config.pins, v, owner, config.maxSlotLag)
	if e != nil {
		return zero, e
	}
	if e = recheckWENMiningFundingReviewV1(dbPath, walletID, v, config, owner); e != nil {
		return zero, e
	}
	return out, nil
}
