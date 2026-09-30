package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
)

// Control-only installer; exact canonical draft bytes must match the operator's
// preview hash. Does not create a review, authorize execution or sign anything.
func (s *signerServiceV2) installWENMarketDraftV1(ctx context.Context, cfg signerConfig, wallet string, d wenMarketDraftV1, expected string, control bool, factory func(string) wenMarketExecutionRPCV1) (string, error) {
	bad := errors.New("market draft installation rejected")
	if e := requireControlSocketV2(control); e != nil {
		return "", e
	}
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil || !filepath.IsAbs(cfg.stateDBPath) || filepath.Clean(cfg.stateDBPath) != cfg.stateDBPath {
		return "", bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return "", e
	}
	if d.validate(wallet) != nil {
		return "", bad
	}
	raw, e := json.Marshal(d)
	if e != nil {
		return "", e
	}
	hash := wenHashV1(raw)
	if !wenReservationHashV1(expected) || hash != expected {
		return "", bad
	}
	record, e := s.keys.PublicRecord(wallet)
	if e != nil || record.PublicKey != d.WalletPublicKey {
		return "", bad
	}
	owner, e := solana.PublicKeyFromBase58(record.PublicKey)
	if e != nil {
		return "", e
	}
	operation, program, genesis := d.identity()
	policy, e := s.store.getPolicy(wallet)
	if e != nil || !containsStringV2(policy.Operations, operation) || !containsStringV2(policy.Programs, program) {
		return "", bad
	}
	network, e := s.keys.SolanaNetworkV2(wallet)
	if e != nil || network.GenesisHash != genesis {
		return "", bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "market draft RPC")
	if e != nil {
		return "", e
	}
	client := factory(endpoint)
	if client == nil {
		return "", bad
	}
	if _, e = d.prepare(ctx, client, owner); e != nil {
		return "", e
	}
	latest, e := s.keys.SolanaNetworkV2(wallet)
	if e != nil || !reflect.DeepEqual(latest, network) {
		return "", bad
	}
	who, e := s.keys.PublicRecord(wallet)
	if e != nil || who.PublicKey != record.PublicKey {
		return "", bad
	}
	p, e := s.store.getPolicy(wallet)
	if e != nil || p.Hash != policy.Hash {
		return "", bad
	}
	parent := filepath.Dir(cfg.stateDBPath)
	if e = checkWENMiningRootV1(parent, parent); e != nil {
		return "", e
	}
	root := parent
	for _, name := range []string{"wen-campaign", wenHashV1([]byte(wallet))} {
		root = filepath.Join(root, name)
		if e = os.Mkdir(root, 0700); e != nil && !os.IsExist(e) {
			return "", e
		}
		if e = checkWENMiningRootV1(root, parent); e != nil {
			return "", e
		}
		info, e := os.Lstat(root)
		if e != nil || info.Mode().Perm() != 0700 {
			return "", bad
		}
		if e = syncWENBTCDirectoryV1(filepath.Dir(root)); e != nil {
			return "", e
		}
	}
	lock, e := acquireSignerEnrollmentLock(filepath.Join(root, ".market-install.lock"))
	if e != nil {
		return "", e
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	if e = ctx.Err(); e != nil {
		return "", e
	}
	if e = publishWENMiningObjectV1(root, "market-draft-"+hash+".json", raw); e != nil {
		return "", e
	}
	loaded, e := loadWENMarketDraftV1(cfg.stateDBPath, wallet, hash)
	if e != nil || !reflect.DeepEqual(loaded, d) {
		return "", bad
	}
	return hash, nil
}

func (s *signerServiceV2) installWENMarketAdmissionV1(ctx context.Context, cfg signerConfig, wallet, request, expected string, control bool, factory func(string) wenMarketExecutionRPCV1) error {
	bad := errors.New("market admission installation rejected")
	if e := requireControlSocketV2(control); e != nil {
		return e
	}
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || factory == nil {
		return bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return e
	}
	var a wenMarketReviewArtifactV1
	load := func() error {
		return s.store.db.View(func(tx *bolt.Tx) error {
			r, _, _, e := loadReviewAndPolicyForAuthorizationV2(tx, wallet, request, s.store.now().UTC())
			if e != nil {
				return e
			}
			if r.ArtifactDigest != "sha256:"+expected {
				return bad
			}

			if r.ArtifactKind != wenMarketArtifactKindV1 {
				return bad
			}
			return decodeSignerAdminStrictJSON(r.SemanticIntent, &a)
		})
	}
	if e := load(); e != nil {
		return e
	}
	hash, e := a.digest()
	publicKey, genesis := a.WalletPublicKey, a.Policy.Successor.Genesis

	if e != nil || hash != expected {
		return bad
	}
	record, e := s.keys.PublicRecord(wallet)
	if e != nil || record.PublicKey != publicKey {
		return bad
	}
	network, e := s.keys.SolanaNetworkV2(wallet)
	if e != nil || network.GenesisHash != genesis {
		return bad
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "market admission RPC")
	if e != nil {
		return e
	}
	client := factory(endpoint)
	if client == nil {
		return bad
	}
	b := a.Binding
	previous := &wenMarketPreparedBuyV1{pins: a.Pins, policy: a.Policy, limits: a.Limits, maxFee: b.MaxFee, retainedLamports: b.RetainedLamports, snapshot: b.Snapshot, message: b.Message, blockhash: b.Blockhash, fee: b.Fee, currentHeight: b.CurrentHeight, lastValidHeight: b.LastValidHeight}
	if _, e = prepareWENMarketBuyV1(ctx, client, a.Pins, a.Policy, a.Limits, b.MaxFee, b.RetainedLamports, previous); e != nil {
		return e
	}

	if e = load(); e != nil {
		return e
	}
	latest, e := s.keys.SolanaNetworkV2(wallet)
	if e != nil || !reflect.DeepEqual(latest, network) {
		return bad
	}
	who, e := s.keys.PublicRecord(wallet)
	if e != nil || who.PublicKey != record.PublicKey {
		return bad
	}
	root, e := wenCampaignProtectedRootV1(cfg.stateDBPath, wallet)
	if e != nil {
		return e
	}
	lock, e := acquireSignerEnrollmentLock(filepath.Join(root, ".market-install.lock"))
	if e != nil {
		return e
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	if e = ctx.Err(); e != nil {
		return e
	}
	raw, e := json.Marshal(wenCampaignAdmissionV1{Version: 1, WalletID: wallet, ArtifactDigest: hash})
	if e != nil {
		return e
	}
	if e = publishWENMiningObjectV1(root, hash+".json", raw); e != nil {
		return e
	}
	return loadWENCampaignDigestAdmissionV1(cfg.stateDBPath, wallet, hash)
}
