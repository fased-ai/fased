package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

type wenMiningReviewInstallV1 struct {
	CommitRequest    string                  `json:"commitRequest"`
	BaseReviewSHA256 string                  `json:"baseReviewSha256"`
	Intent           signerWENMiningIntentV1 `json:"intent"`
}
type wenMiningReviewReceiptV1 struct {
	WalletID         string `json:"walletId"`
	BaseReviewSHA256 string `json:"baseReviewSha256"`
	IntentSHA256     string `json:"intentSha256"`
	Status           string `json:"status"`
	ReviewSHA256     string `json:"reviewSha256"`
	SigningEnabled   bool   `json:"signingEnabled"`
}

// Owner-control-only, reveal-only extension of an existing protected commit
// review. Never accepts new deployment pins and never overwrites another review.
func (s *signerServiceV2) installMiningRevealReviewV1(ctx context.Context, cfg signerConfig, walletID string, body wenMiningReviewInstallV1, control bool, factory func(string) wenMiningExecutionRPCV1) (wenMiningReviewReceiptV1, error) {
	var out wenMiningReviewReceiptV1
	bad := errors.New("mining reveal review installation rejected")
	if e := requireControlSocketV2(control); e != nil {
		return out, e
	}
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return out, bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return out, e
	}
	if validateWENMiningIntentV1(body.Intent) != nil || body.Intent.Operation != "reveal" || !wenReservationHashV1(body.BaseReviewSHA256) {
		return out, bad
	}
	if _, e := validateRequestIDV2(body.CommitRequest); e != nil {
		return out, e
	}
	var commit wenBudgetReservationV1
	if e := s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		if json.Unmarshal(b.Get([]byte("request:"+body.CommitRequest)), &commit) != nil || commit.WalletID != walletID || commit.MiningIntent == nil {
			return bad
		}
		return nil
	}); e != nil {
		return out, e
	}
	base, wallet, e := loadWENMiningAdmissionV1(cfg.stateDBPath, walletID, *commit.MiningIntent)
	if e != nil || !base.RequireLaunchBudget || base.reviewSHA != body.BaseReviewSHA256 {
		return out, bad
	}
	lock, e := acquireSignerEnrollmentLock(filepath.Join(base.Root, ".mining-review-install.lock"))
	if e != nil {
		return out, e
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	minimum, _ := strconv.ParseUint(body.Intent.MinFinalizedSlot, 10, 64)
	expires, _ := strconv.ParseUint(body.Intent.ExpiresSlot, 10, 64)
	proposal, e := s.store.proposeWENMiningRevealV1(body.CommitRequest, walletID, minimum, expires)
	if e != nil || proposal != body.Intent {
		return out, bad
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != wallet.String() {
		return out, bad
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != proposal.Genesis {
		return out, bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining review installation RPC")
	if e != nil {
		return out, e
	}
	client := factory(endpoint)
	if client == nil {
		return out, bad
	}
	phase, e := readWENMiningPhaseRPCV1(ctx, client, base.Root, base.Pins, proposal, wallet, base.MaxSlotLag)
	if e != nil || (phase != "waiting-reveal" && phase != "ready-reveal") {
		return out, bad
	}
	latest, w, e := loadWENMiningAdmissionV1(cfg.stateDBPath, walletID, *commit.MiningIntent)
	if e != nil || latest.reviewSHA != body.BaseReviewSHA256 || w != wallet {
		return out, bad
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	review := wenMiningReviewV1{Version: 2, WalletID: walletID, WalletPublicKey: wallet.String(), Intent: proposal, Pins: base.Pins, MaxSlotLag: base.MaxSlotLag}
	raw, e := json.Marshal(review)
	if e != nil {
		return out, e
	}
	hash := wenHashV1(raw)
	stage, e := os.CreateTemp(base.Root, ".mining-review-*.tmp")
	if e != nil {
		return out, e
	}
	defer os.Remove(stage.Name())
	if _, e = stage.Write(raw); e == nil {
		e = stage.Sync()
	}
	closed := stage.Close()
	if e != nil {
		return out, e
	}
	if closed != nil {
		return out, closed
	}
	target := filepath.Join(base.Root, wenMiningAdmissionNameV2(proposal))
	if e = os.Link(stage.Name(), target); e != nil && !os.IsExist(e) {
		return out, e
	}
	if e = syncWENBTCDirectoryV1(base.Root); e != nil {
		return out, e
	}
	installed, _, e := loadWENMiningAdmissionV1(cfg.stateDBPath, walletID, proposal)
	if e != nil || installed.reviewSHA != hash {
		return out, bad
	}
	intentRaw, _ := json.Marshal(proposal)
	return wenMiningReviewReceiptV1{Status: "review-installed", ReviewSHA256: hash, WalletID: walletID, BaseReviewSHA256: body.BaseReviewSHA256, IntentSHA256: wenHashV1(intentRaw)}, nil
}
func (s *signerServiceV2) installMiningRevealReviewServiceV1(req request, cfg signerConfig, control bool) ([]byte, error) {
	if e := requireControlSocketV2(control); e != nil {
		return nil, e
	}
	var body wenMiningReviewInstallV1
	if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
		return nil, e
	}
	result, e := s.installMiningRevealReviewV1(context.Background(), cfg, req.WalletID, body, control, func(endpoint string) wenMiningExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
	if e != nil {
		return nil, e
	}
	return marshalSignerResultV2(result)
}
