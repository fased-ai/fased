package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"syscall"
)

// Owner supplies explicitly reviewed pins, never inferred from an application or
// RPC response. Descriptor is base64 in JSON so its exact hashed bytes survive transport.
type wenMiningBootstrapV1 struct {
	Review     wenMiningReviewV1 `json:"review"`
	Descriptor []byte            `json:"descriptor"`
}

func publishWENMiningObjectV1(root, name string, raw []byte) error {
	stage, e := os.CreateTemp(root, ".mining-install-*.tmp")
	if e != nil {
		return e
	}
	defer os.Remove(stage.Name())
	if _, e = stage.Write(raw); e == nil {
		e = stage.Sync()
	}
	closed := stage.Close()
	if e != nil {
		return e
	}
	if closed != nil {
		return closed
	}
	target := filepath.Join(root, name)
	if e = os.Link(stage.Name(), target); e != nil && !os.IsExist(e) {
		return e
	}
	actual, e := readSignerAdminJSONFile(target, 65536)
	defer zeroBytes(actual)
	if e != nil {
		return e
	}
	if !bytes.Equal(actual, raw) {
		return errors.New("mining installation conflict; existing file preserved")
	}
	return syncWENBTCDirectoryV1(root)
}

func (s *signerServiceV2) installMiningBootstrapV1(ctx context.Context, cfg signerConfig, walletID string, body wenMiningBootstrapV1, control bool, factory func(string) wenMiningExecutionRPCV1) (wenMiningReviewReceiptV1, error) {
	var out wenMiningReviewReceiptV1
	bad := errors.New("mining bootstrap rejected")
	if e := requireControlSocketV2(control); e != nil {
		return out, e
	}
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return out, bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return out, e
	}
	if !filepath.IsAbs(cfg.stateDBPath) || filepath.Clean(cfg.stateDBPath) != cfg.stateDBPath {
		return out, bad
	}
	r := body.Review
	v := r.Intent
	if walletID == "" || normalizeWalletID(walletID) != walletID || r.WalletID != walletID || r.Version != 2 || v.Operation != "commit" || validateWENMiningIntentV1(v) != nil {
		return out, bad
	}
	if e := validateWENMiningDescriptorV1(body.Descriptor, r.Pins); e != nil {
		return out, e
	}
	if r.Pins.DescriptorSHA256 != v.DescriptorSHA256 || r.Pins.CapabilitySHA256 != v.CapabilitySHA256 || r.Pins.ProgramID != v.ProgramID || r.Pins.Genesis != v.Genesis {
		return out, bad
	}
	minimum, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	if r.Pins.DeploymentSlot > minimum {
		return out, bad
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != r.WalletPublicKey {
		return out, bad
	}
	wallet, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil || wallet.IsZero() || wallet.String() != r.WalletPublicKey {
		return out, bad
	}
	root := filepath.Join(filepath.Dir(cfg.stateDBPath), "wen-mining", wenHashV1([]byte(walletID)))
	// Existing protected preimage/root provisioning is required. Never accept a
	// secret or choose a new preimage through this review installation operation.
	if e = checkWENMiningRootV1(root, filepath.Dir(cfg.stateDBPath)); e != nil {
		return out, e
	}
	lock, e := acquireSignerEnrollmentLock(filepath.Join(root, ".mining-review-install.lock"))
	if e != nil {
		return out, e
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != v.Genesis {
		return out, bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining bootstrap RPC")
	if e != nil {
		return out, e
	}
	client := factory(endpoint)
	if client == nil {
		return out, bad
	}
	phase, e := readWENMiningPhaseRPCV1(ctx, client, root, r.Pins, v, wallet, r.MaxSlotLag)
	if e != nil || (phase != "waiting-open" && phase != "ready-commit") {
		return out, bad
	}
	latest, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || !reflect.DeepEqual(latest, network) {
		return out, bad
	}
	public, e := s.keys.PublicRecord(walletID)
	if e != nil || public.PublicKey != record.PublicKey {
		return out, bad
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	raw, e := json.Marshal(r)
	if e != nil {
		return out, e
	}
	// Publish content first; interrupted installation leaves only an inert object.
	// Review publication never replaces an existing right or review.
	if e = publishWENMiningObjectV1(root, r.Pins.DescriptorSHA256, body.Descriptor); e != nil {
		return out, e
	}
	if e = publishWENMiningObjectV1(root, wenMiningAdmissionNameV2(v), raw); e != nil {
		return out, e
	}
	admitted, w, e := loadWENMiningAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil || w != wallet || admitted.reviewSHA != wenHashV1(raw) {
		return out, bad
	}
	intent, _ := json.Marshal(v)
	return wenMiningReviewReceiptV1{WalletID: walletID, IntentSHA256: wenHashV1(intent), Status: "review-installed", ReviewSHA256: admitted.reviewSHA}, nil
}
func (s *signerServiceV2) installMiningBootstrapServiceV1(req request, cfg signerConfig, control bool) ([]byte, error) {
	if e := requireControlSocketV2(control); e != nil {
		return nil, e
	}
	var body wenMiningBootstrapV1
	if len(req.Request) > 65536 {
		return nil, errors.New("mining bootstrap too large")
	}
	if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
		return nil, e
	}
	out, e := s.installMiningBootstrapV1(context.Background(), cfg, req.WalletID, body, control, func(endpoint string) wenMiningExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
	if e != nil {
		return nil, e
	}
	return marshalSignerResultV2(out)
}
