package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Validate every canonical entry/preimage property independently of its current
// phase, then classify using the actual observed time. The normalized snapshot
// is validation-only: it is never returned, signed or submitted.
func classifyWENMiningPhaseV1(v signerWENMiningIntentV1, wallet solana.PublicKey, snapshot wenMiningEntrySnapshotV1, material []byte) (string, error) {
	if e := validateWENMiningIntentV1(v); e != nil {
		return "", e
	}
	open, _ := strconv.ParseUint(v.Open, 10, 64)
	check := snapshot
	check.Now = open
	var reveal []byte
	if v.Operation == "reveal" {
		check.Now = open + 180
		reveal = material
	}
	if _, e := prepareWENMiningInstructionV1(v, wallet, check, reveal); e != nil {
		return "", e
	}
	if snapshot.Now > uint64(1<<63-1) {
		return "", errors.New("invalid mining clock")
	}
	if snapshot.Now < open {
		return "waiting-open", nil
	}
	elapsed := snapshot.Now - open
	if elapsed >= 900 {
		return "expired", nil
	}
	if v.Operation == "commit" {
		if elapsed >= 180 {
			return "missed-commit", nil
		}
		return "ready-commit", nil
	}
	if elapsed < 180 {
		return "waiting-reveal", nil
	}
	return "ready-reveal", nil
}

func readWENMiningPhaseRPCV1(ctx context.Context, c signerWENBTCReadRPCV1, root string, pins wenMiningPinsV1, v signerWENMiningIntentV1, wallet solana.PublicKey, maxLag uint64) (string, error) {
	material, e := loadWENMiningPreimageV1(root, v, wallet)
	if e != nil {
		return "", e
	}
	defer zeroBytes(material)
	phase := ""
	_, e = readWENMiningValidatedRPCV1(ctx, c, pins, v, maxLag, func(snapshot wenMiningEntrySnapshotV1) error {
		var err error
		phase, err = classifyWENMiningPhaseV1(v, wallet, snapshot, material)
		return err
	})
	if e != nil {
		return "", e
	}
	return phase, nil
}

// Observation happens before reserving fees. Ready work still traverses the
// configured executor's fresh policy, review, network, phase and signing checks.
func (s *signerServiceV2) executePhaseReadyMiningV1(ctx context.Context, cfg signerConfig, request, walletID string, v signerWENMiningIntentV1, factory func(string) wenMiningExecutionRPCV1) (string, string, error) {
	config, wallet, e := loadWENMiningAdmissionV1(cfg.stateDBPath, walletID, v)
	if e != nil {
		return "", "", e
	}
	record, e := s.keys.PublicRecord(walletID)
	if e != nil || record.PublicKey != wallet.String() {
		return "", "", errors.New("mining phase wallet mismatch")
	}
	network, e := s.keys.SolanaNetworkV2(walletID)
	if e != nil || network.GenesisHash != v.Genesis {
		return "", "", errors.New("mining phase network mismatch")
	}
	endpoint, e := normalizeSignerRPCURLV2(network.PrimaryRPCURL, "mining phase RPC")
	if e != nil {
		return "", "", e
	}
	client := factory(endpoint)
	if client == nil {
		return "", "", errors.New("mining phase RPC unavailable")
	}
	phase, e := readWENMiningPhaseRPCV1(ctx, client, config.Root, config.Pins, v, wallet, config.MaxSlotLag)
	if e != nil {
		return "", "", e
	}
	if phase != "ready-"+v.Operation {
		return "", phase, nil
	}
	return s.executeConfiguredMiningWithFactoryV1(ctx, cfg, request, walletID, v, factory)
}
