package main

import (
	"bytes"
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func satRewardEntryIntentV2(intent normalizedIntentV2) *normalizedIntentV2 {
	if intent.Intent.Type == intentSolanaSATKeeperAction && intent.ParentIntent != nil {
		return satRewardEntryIntentV2(*intent.ParentIntent)
	}
	if (intent.Intent.Type == intentSolanaSATAction || intent.Intent.Type == intentSolanaSATKeeperAction) && (intent.Intent.Action == "openCycleV2" || intent.Intent.Action == "commitCycleV2") {
		return &intent
	}
	return nil
}

func validateSATRewardGlobalV2(account *rpc.Account, program, expected solana.PublicKey) error {
	if account == nil || account.Owner != program || account.Executable || account.Data == nil {
		return errors.New("SAT reward admission: missing or invalid global account")
	}
	data := account.Data.GetBinary()
	if len(data) < 264 || data[0] != 130 || !bytes.Equal(data[1:8], make([]byte, 7)) {
		return errors.New("SAT reward admission: invalid global layout")
	}
	if !bytes.Equal(data[232:264], expected[:]) {
		return errors.New("SAT reward admission: incompatible distributor; preserve claims and drain before migration")
	}
	return nil
}

// Independent signer-owned finalized read. Only new entry is gated; existing
// commitments, settlement and claims retain their own validation paths.
func validateSATRewardEntryRPCV2(urls []string, intent normalizedIntentV2) error {
	entry := satRewardEntryIntentV2(intent)
	if entry == nil {
		return nil
	}
	runtime := signerRoleBaselineRuntimeFromEnvV1()
	if !runtime.Verified {
		return errors.New("SAT reward admission requires verified runtime identities")
	}
	program, err := solana.PublicKeyFromBase58(runtime.SATProgramID)
	if err != nil {
		return err
	}
	if entry.Intent.ProgramID != program.String() {
		return errors.New("SAT reward admission program mismatch")
	}
	bond, err := solana.PublicKeyFromBase58(runtime.SATBondProgramID)
	if err != nil {
		return err
	}
	return readSATRewardEntryGlobalRPCV2(urls, program, bond)
}

func readSATRewardEntryGlobalRPCV2(urls []string, program, bond solana.PublicKey) error {
	global, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_global_state_v2")}, program)
	if err != nil {
		return err
	}
	expected, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_bond_epoch_distributor_v3")}, bond)
	if err != nil {
		return err
	}
	for _, url := range urls {
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, readErr := newSignerOwnedSolanaRPCClientV2(url).GetAccountInfoWithOpts(ctx, global, &rpc.GetAccountInfoOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentFinalized})
		cancel()
		if readErr != nil {
			continue
		}
		if result == nil {
			return errors.New("SAT reward admission: missing global response")
		}
		return validateSATRewardGlobalV2(result.Value, program, expected)
	}
	return errors.New("SAT reward admission: signer RPC unavailable")
}
