package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

func validateWENMiningClaimDescriptorV1(raw []byte, p wenStakingPinsV1) error {
	if len(raw) == 0 || len(raw) > 32768 || wenHashV1(raw) != p.DescriptorSHA256 {
		return errors.New("mining claim descriptor pin mismatch")
	}
	var strict map[string]any
	if err := decodeStrictJSONV2(raw, &strict); err != nil {
		return err
	}
	var d map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&d); err != nil {
		return err
	}
	expected := []string{"$schema", "descriptorVersion", "stage", "source", "componentGenerations", "build", "interfaces", "deployment", "runtimeCompatibility", "publication", "receiptBinding", "descriptorDigest"}
	if len(d) != len(expected) {
		return errors.New("descriptor field set")
	}
	for _, k := range expected {
		if _, ok := d[k]; !ok {
			return errors.New("descriptor missing field")
		}
	}
	if d["$schema"] != "sat.release-descriptor.v2" || d["descriptorVersion"] != json.Number("2") || d["stage"] != "deployed-release" {
		return errors.New("descriptor not deployment bound")
	}
	internal := d["descriptorDigest"]
	delete(d, "descriptorDigest")
	canonical, err := wenJSONV1(d)
	if err != nil || internal != "sha256:"+wenHashV1(canonical) {
		return errors.New("descriptor internal digest mismatch")
	}
	object := func(k string) map[string]any { v, _ := d[k].(map[string]any); return v }
	for _, k := range []string{"source", "componentGenerations", "build", "interfaces", "deployment", "runtimeCompatibility"} {
		if object(k)["status"] != "BOUND" {
			return errors.New("descriptor section not bound")
		}
	}
	for _, k := range []string{"deployment", "runtimeCompatibility", "publication", "receiptBinding"} {
		v := object(k)
		reason, _ := v["reason"].(string)
		if reason == "" || (v["status"] != "BOUND" && v["status"] != "NOT_BOUND") {
			return errors.New("descriptor section status")
		}
	}
	h, ok := object("interfaces")["miningClaimHandoff"].(map[string]any)
	if !ok || len(h) != 9 || h["schema"] != "wen.mining-claim-handoff-candidate.v1" || h["stage"] != "source-candidate" || h["publicEntryEnabled"] != false || h["portableClient"] != "client/mining-claim-instruction.mjs" || h["sourceDigest"] != object("source")["sourceDigest"] || h["contractDigest"] != object("interfaces")["contractDigest"] {
		return errors.New("invalid mining claim handoff")
	}
	for _, k := range []string{"sourceDigest", "contractDigest"} {
		v, _ := h[k].(string)
		if !wenReservationHashV1(v) {
			return errors.New("invalid mining claim source digest")
		}
	}
	operations, ok := h["operations"].([]any)
	if !ok || len(operations) != 2 || operations[0] != "sol" || operations[1] != "sat" {
		return errors.New("invalid mining claim operations")
	}
	ops, ok := h["instructions"].([]any)
	if !ok || len(ops) != 2 {
		return errors.New("invalid mining claim instructions")
	}
	roles := []string{"owner", "sale", "offer", "roster", "settlementReceipt", "entry", "claim", "activation", "satReservationLedger", "satRewardVault", "destination", "satMint", "tokenProgram"}
	for n, rawOp := range ops {
		op, ok := rawOp.(map[string]any)
		if !ok || len(op) != 4 || op["name"] != []string{"mining_claim::sol_instruction", "mining_claim::sat_instruction"}[n] || op["opcode"] != json.Number(strconv.Itoa(82+n)) || op["dataLength"] != json.Number("25") {
			return errors.New("invalid mining claim instruction shape")
		}
		accounts, ok := op["accounts"].([]any)
		if !ok || len(accounts) != []int{7, 13}[n] {
			return errors.New("invalid mining claim account count")
		}
		for j, rawAccount := range accounts {
			a, ok := rawAccount.(map[string]any)
			writable := j == 0 || j == 4 || j == 6 || j == 8 || j == 9 || j == 10
			if !ok || len(a) != 3 || a["role"] != roles[j] || a["signer"] != (j == 0) || a["writable"] != writable {
				return errors.New("invalid mining claim account role")
			}
		}
	}
	capability := make(map[string]any, len(h)-1)
	for k, v := range h {
		if k != "capabilityDigest" {
			capability[k] = v
		}
	}
	encoded, err := wenJSONV1(capability)
	if err != nil {
		return err
	}
	digest := wenHashV1(bytes.TrimSuffix(encoded, []byte{'\n'}))
	if digest != p.CapabilitySHA256 || h["capabilityDigest"] != digest || object("componentGenerations")["miningClaimCapability"] != digest || object("runtimeCompatibility")["miningClaimCapability"] != digest {
		return errors.New("mining claim capability not acknowledged")
	}
	deployment, _ := object("deployment")["miningClaim"].(map[string]any)
	program, err := solana.PublicKeyFromBase58(p.ProgramID)
	if err != nil {
		return err
	}
	var authority any
	if p.UpgradeAuthority != nil {
		authority = hex.EncodeToString(p.UpgradeAuthority[:])
	}
	code, codeErr := hex.DecodeString(p.CodeSHA256)
	if p.DeploymentSlot == 0 || codeErr != nil || len(code) != 32 || hex.EncodeToString(code) != p.CodeSHA256 || deployment["program"] != hex.EncodeToString(program[:]) || deployment["genesis"] != p.Genesis || deployment["deploymentSlot"] != strconv.FormatUint(p.DeploymentSlot, 10) || deployment["deployedBytesHash"] != p.CodeSHA256 || deployment["upgradeAuthority"] != authority {
		return errors.New("descriptor differs from signer deployment pins")
	}
	return nil
}
