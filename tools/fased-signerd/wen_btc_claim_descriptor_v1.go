package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

func validateWENBTCClaimDescriptorV1(raw []byte, p wenStakingPinsV1) error {
	if len(raw) == 0 || len(raw) > 32768 || wenHashV1(raw) != p.DescriptorSHA256 {
		return errors.New("staking descriptor pin mismatch")
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
	var envelope struct {
		Interfaces struct {
			Handoff struct {
				Schema            string          `json:"schema"`
				Operations        []string        `json:"operations"`
				InstructionDigest string          `json:"instructionDigest"`
				CapabilityDigest  string          `json:"capabilityDigest"`
				SourceDigest      string          `json:"sourceDigest"`
				ContractDigest    string          `json:"contractDigest"`
				PortableClient    string          `json:"portableClient"`
				Instructions      json.RawMessage `json:"instructions"`
			} `json:"btcClaimHandoff"`
		} `json:"interfaces"`
	}
	if err = json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	h := envelope.Interfaces.Handoff
	instructions, err := wenCompactV1(h.Instructions)
	if err != nil {
		return err
	}
	var ops []struct {
		Opcode     int    `json:"opcode"`
		Name       string `json:"name"`
		DataLength int    `json:"dataLength"`
		Accounts   []struct {
			Role     string `json:"role"`
			Signer   *bool  `json:"signer"`
			Writable *bool  `json:"writable"`
		} `json:"accounts"`
	}
	if err = json.Unmarshal(instructions, &ops); err != nil {
		return err
	}
	if !wenReservationHashV1(h.SourceDigest) || !wenReservationHashV1(h.ContractDigest) || h.Schema != "wen.btc-claim-handoff-candidate.v1" || h.PortableClient != "client/btc-claim-preparation.mjs" || len(h.Operations) != 2 || h.Operations[0] != "fee-staking-btc-claim" || h.Operations[1] != "mining-staking-btc-claim" || len(ops) != 2 || ops[0].Opcode != 53 || ops[1].Opcode != 101 || wenHashV1(instructions) != h.InstructionDigest || h.SourceDigest != object("source")["sourceDigest"] || h.ContractDigest != object("interfaces")["contractDigest"] {
		return errors.New("descriptor staking instruction binding")
	}
	roles := []string{"owner", "sale", "activation", "tranche", "cohort", "history", "settlement", "fallbackClaim", "paid", "btcVault", "destination", "routeAuthority", "btcMint", "systemProgram", "tokenProgram"}
	for n, op := range ops {
		name := []string{"btc_settlement::claim_instruction", "btc_settlement::claim_instruction_for_source"}[n]
		if op.Name != name || op.DataLength != []int{17, 25}[n] || len(op.Accounts) != 15 {
			return errors.New("invalid staking instruction shape")
		}
		for j, a := range op.Accounts {
			writable := j == 0 || j == 6 || j == 8 || j == 9 || j == 10
			if a.Role != roles[j] || a.Signer == nil || a.Writable == nil || *a.Signer != (j == 0) || *a.Writable != writable {
				return errors.New("invalid staking instruction accounts")
			}
		}
	}
	capability := struct {
		Operations        []string `json:"operations"`
		InstructionDigest string   `json:"instructionDigest"`
		SourceDigest      string   `json:"sourceDigest"`
		ContractDigest    string   `json:"contractDigest"`
		PortableClient    string   `json:"portableClient"`
	}{h.Operations, h.InstructionDigest, h.SourceDigest, h.ContractDigest, h.PortableClient}
	encoded, err := wenJSONV1(capability)
	if err != nil {
		return err
	}
	digest := wenHashV1(bytes.TrimSuffix(encoded, []byte{'\n'}))
	if digest != p.CapabilitySHA256 || h.CapabilityDigest != digest || object("componentGenerations")["btcClaimCapability"] != digest || object("runtimeCompatibility")["btcClaimCapability"] != digest {
		return errors.New("descriptor capability not acknowledged")
	}
	deployment, _ := object("deployment")["btcClaim"].(map[string]any)
	program, err := solana.PublicKeyFromBase58(p.ProgramID)
	if err != nil {
		return err
	}
	var authority any
	if p.UpgradeAuthority != nil {
		authority = hex.EncodeToString(p.UpgradeAuthority[:])
	}
	code, codeErr := hex.DecodeString(p.CodeSHA256)
	if !wenDescriptorSlotMatchesV1(deployment["deploymentSlot"], p.DeploymentSlot) || codeErr != nil || len(code) != 32 || hex.EncodeToString(code) != p.CodeSHA256 || deployment["program"] != hex.EncodeToString(program[:]) || deployment["genesis"] != p.Genesis || deployment["deployedBytesHash"] != p.CodeSHA256 || deployment["upgradeAuthority"] != authority {
		return errors.New("descriptor differs from signer deployment pins")
	}
	return nil
}
