package main

import (
	"context"
	"errors"
	"reflect"
)

// An admission is only a locator, including when execution never created a
// journal. The full finalized settlement verifier determines whether it is
// payable. This host neither installs a claim review nor authorizes signing.
func (s *signerServiceV2) proposeAdmissionWENMiningClaimV1(ctx context.Context, cfg signerConfig, walletID string, mining signerWENMiningIntentV1, operation string, pins wenStakingPinsV1, descriptor []byte, minimum, expires, maxFee, maxLag uint64, factory func(string) signerWENBTCReadRPCV1) (wenMiningDiscoveredClaimV1, error) {
	var zero wenMiningDiscoveredClaimV1
	bad := errors.New("claim host admission or configuration changed")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() || factory == nil || mining.Operation != "commit" {
		return zero, bad
	}
	if err := cfg.ensureChainAllowed("solana"); err != nil {
		return zero, err
	}
	admission, owner, err := loadWENMiningAdmissionV1(cfg.stateDBPath, walletID, mining)
	if err != nil {
		return zero, err
	}
	p := admission.Pins
	if p.ProgramID != pins.ProgramID || p.Genesis != pins.Genesis || p.CodeSHA256 != pins.CodeSHA256 || p.DeploymentSlot != pins.DeploymentSlot || !reflect.DeepEqual(p.UpgradeAuthority, pins.UpgradeAuthority) {
		return zero, bad
	}
	public, err := s.keys.PublicRecord(walletID)
	if err != nil || public.PublicKey != owner.String() {
		return zero, bad
	}
	network, err := s.keys.SolanaNetworkV2(walletID)
	if err != nil || network.GenesisHash != mining.Genesis {
		return zero, bad
	}
	endpoint, err := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "claim admission host RPC")
	if err != nil {
		return zero, err
	}
	if err = ctx.Err(); err != nil {
		return zero, err
	}
	client := factory(endpoint)
	if client == nil {
		return zero, bad
	}
	candidate := wenMiningClaimCandidateV1{Intent: mining, Source: "protected-admission", Status: "requires-settlement-readback"}
	out, err := proposeDiscoveredWENMiningClaimV1(ctx, client, pins, descriptor, candidate, owner, operation, minimum, expires, maxFee, maxLag)
	if err != nil {
		return zero, err
	}
	latest, err := s.keys.SolanaNetworkV2(walletID)
	if err != nil || !reflect.DeepEqual(latest, network) {
		return zero, bad
	}
	record, err := s.keys.PublicRecord(walletID)
	if err != nil || record.PublicKey != public.PublicKey {
		return zero, bad
	}
	again, latestOwner, err := loadWENMiningAdmissionV1(cfg.stateDBPath, walletID, mining)
	if err != nil || latestOwner != owner || !reflect.DeepEqual(again, admission) {
		return zero, bad
	}
	if err = ctx.Err(); err != nil {
		return zero, err
	}
	return out, nil
}
