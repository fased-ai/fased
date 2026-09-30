package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
)

// Semantic public intent: never instruction bytes, nonce or allocation.
type signerVaultMiningIntentV1 struct {
	Profile              string `json:"profile"`
	PermanentMining      string `json:"permanentMining"`
	Reference            string `json:"reference"`
	CycleID              string `json:"cycleId"`
	CommittedLamports    string `json:"committedLamports"`
	AuthorityGeneration  string `json:"authorityGeneration"`
	BindingGeneration    string `json:"bindingGeneration"`
	ActivationGeneration string `json:"activationGeneration"`
	MaxRentLamports      string `json:"maxRentLamports"`
	MaxFeeLamports       string `json:"maxFeeLamports"`
	MinFinalizedSlot     string `json:"minFinalizedSlot"`
}

func vaultCanonicalU64V1(raw string, positive bool) (uint64, error) {
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || strconv.FormatUint(v, 10) != raw || (positive && v == 0) {
		return 0, errors.New("Vault intent requires canonical uint64 values")
	}
	return v, nil
}

func normalizeVaultMiningIntentV1(input signerIntentV2, wallet *solana.PublicKey) (normalizedIntentV2, error) {
	var empty normalizedIntentV2
	if wallet == nil || wallet.IsZero() || input.Type != intentSolanaVaultMining || input.Cluster != "devnet" || input.VaultMining == nil || (input.Action != "commit_vault_cycle" && input.Action != "reveal_vault_cycle") {
		return empty, errors.New("invalid dedicated Vault mining intent")
	}
	v := *input.VaultMining
	for _, raw := range []string{v.Profile, v.PermanentMining} {
		key, err := solana.PublicKeyFromBase58(raw)
		if err != nil || key.IsZero() || key.String() != raw {
			return empty, errors.New("invalid Vault intent identity")
		}
	}
	if d, err := normalizeSHA256DigestV2(v.Reference, "commitment reference"); err != nil || d != v.Reference {
		return empty, errors.New("invalid Vault commitment reference")
	}
	for _, raw := range []string{v.CycleID, v.CommittedLamports, v.AuthorityGeneration, v.BindingGeneration, v.MinFinalizedSlot, v.MaxFeeLamports} {
		if _, err := vaultCanonicalU64V1(raw, true); err != nil {
			return empty, err
		}
	}
	activation, err := vaultCanonicalU64V1(v.ActivationGeneration, input.Action == "commit_vault_cycle")
	if err != nil {
		return empty, err
	}
	rent, err := vaultCanonicalU64V1(v.MaxRentLamports, false)
	if err != nil {
		return empty, err
	}
	fee, _ := vaultCanonicalU64V1(v.MaxFeeLamports, true)
	if fee > signerNativeFeeReservationV2 || rent > ^uint64(0)-fee {
		return empty, errors.New("Vault fee/rent ceiling is invalid")
	}
	if input.Action == "reveal_vault_cycle" && (rent != 0 || activation != 0) {
		return empty, errors.New("Vault reveal has no rent or entry-activation authority")
	}
	canonical := signerIntentV2{Type: input.Type, Cluster: input.Cluster, Action: input.Action, VaultMining: &v}
	raw, _ := json.Marshal(input)
	encoded, _ := json.Marshal(canonical)
	if !bytes.Equal(raw, encoded) {
		return empty, errors.New("Vault intent rejects generic transaction fields")
	}
	hash := sha256.Sum256(encoded)
	return normalizedIntentV2{Intent: canonical, Digest: "sha256:" + hex.EncodeToString(hash[:]), Asset: "vault-mining:action", Amount: big.NewInt(1), Destination: agentCapitalProgramIDV1, RequiredPrograms: []string{agentCapitalProgramIDV1, satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID}, RequiredRole: "agent", PolicyOperation: "vaultMining." + input.Action + "@" + agentCapitalProgramIDV1, NativeFeeReservation: new(big.Int).SetUint64(rent + fee)}, nil
}

func vaultIntentBindingRequestV1(intent normalizedIntentV2) vaultMiningBindingRequestV1 {
	v := intent.Intent.VaultMining
	slot, _ := vaultCanonicalU64V1(v.MinFinalizedSlot, true)
	return vaultMiningBindingRequestV1{Cluster: intent.Intent.Cluster, Profile: v.Profile, PermanentMining: v.PermanentMining, MinFinalizedSlot: slot}
}
