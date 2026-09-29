package main

import (
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
type wenMiningClaimBootstrapV1 struct {
	Review     wenMiningClaimReviewV1 `json:"review"`
	Descriptor []byte                 `json:"descriptor"`
}

func (s *signerServiceV2) installMiningClaimBootstrapV1(ctx context.Context, cfg signerConfig, walletID string, body wenMiningClaimBootstrapV1, control bool, factory func(string) wenMiningClaimExecutionRPCV1) (wenMiningReviewReceiptV1, error) {
	var out wenMiningReviewReceiptV1
	bad := errors.New("mining claim bootstrap rejected")
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
	if walletID == "" || normalizeWalletID(walletID) != walletID || r.WalletID != walletID || r.Version != 1 || validateWENMiningClaimIntentV1(v) != nil {
		return out, bad
	}
	if e := validateWENMiningClaimDescriptorV1(body.Descriptor, r.Pins); e != nil {
		return out, e
	}
	if r.Pins.DescriptorSHA256 != v.DescriptorSHA256 || r.Pins.CapabilitySHA256 != v.CapabilitySHA256 || r.Pins.ProgramID != v.ProgramID || r.Pins.Genesis != v.Genesis {
		return out, bad
	}
	minimum, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	fee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if r.Pins.DeploymentSlot == 0 || r.Pins.DeploymentSlot > minimum || r.MaxSlotLag == 0 || r.MaxSlotLag > 32 || r.MaxTotalCostLamports < fee || r.MaxTotalCostLamports > signerNativeFeeReservationV2 {
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
	root := filepath.Join(filepath.Dir(cfg.stateDBPath), "wen-mining-claim", wenHashV1([]byte(walletID)))
	parent := filepath.Dir(cfg.stateDBPath)
	if e = checkWENMiningRootV1(parent, parent); e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	current := parent
	for _, name := range []string{"wen-mining-claim", wenHashV1([]byte(walletID))} {
		current = filepath.Join(current, name)
		if e = os.Mkdir(current, 0700); e != nil && !os.IsExist(e) {
			return out, e
		}
		if e = checkWENMiningRootV1(current, parent); e != nil {
			return out, e
		}
		info, err := os.Lstat(current)
		if err != nil || info.Mode().Perm() != 0700 {
			return out, bad
		}
		if e = syncWENBTCDirectoryV1(filepath.Dir(current)); e != nil {
			return out, e
		}
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
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining claim bootstrap RPC")
	if e != nil {
		return out, e
	}
	client := factory(endpoint)
	if client == nil {
		return out, bad
	}
	observed, e := readWENMiningClaimRPCV1(ctx, client, r.Pins, v, wallet, r.MaxSlotLag)
	if e != nil || observed.StateHash != v.AccountStateSHA256 {
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
	if e = publishWENMiningObjectV1(root, wenMiningClaimAdmissionNameV1(v), raw); e != nil {
		return out, e
	}
	admitted, w, e := loadWENMiningClaimAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil || w != wallet || admitted.reviewSHA != wenHashV1(raw) {
		return out, bad
	}
	intent, _ := json.Marshal(v)
	return wenMiningReviewReceiptV1{WalletID: walletID, IntentSHA256: wenHashV1(intent), Status: "review-installed", ReviewSHA256: admitted.reviewSHA}, nil
}
func (s *signerServiceV2) installMiningClaimBootstrapServiceV1(req request, cfg signerConfig, control bool) ([]byte, error) {
	if e := requireControlSocketV2(control); e != nil {
		return nil, e
	}
	var body wenMiningClaimBootstrapV1
	if len(req.Request) > 65536 {
		return nil, errors.New("mining claim bootstrap too large")
	}
	if e := decodeSignerAdminStrictJSON(req.Request, &body); e != nil {
		return nil, e
	}
	out, e := s.installMiningClaimBootstrapV1(context.Background(), cfg, req.WalletID, body, control, func(endpoint string) wenMiningClaimExecutionRPCV1 { return newSignerOwnedSolanaRPCClientV2(endpoint) })
	if e != nil {
		return nil, e
	}
	return marshalSignerResultV2(out)
}
