package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

func validateWENNativeClaimDescriptorV1(raw []byte, p wenStakingPinsV1) error {
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
				Operation         string          `json:"operation"`
				InstructionDigest string          `json:"instructionDigest"`
				CapabilityDigest  string          `json:"capabilityDigest"`
				SourceDigest      string          `json:"sourceDigest"`
				ContractDigest    string          `json:"contractDigest"`
				PortableClient    string          `json:"portableClient"`
				Instruction       json.RawMessage `json:"instruction"`
				PaidLayout        json.RawMessage `json:"paidLayout"`
			} `json:"ownerClaimHandoff"`
		} `json:"interfaces"`
	}
	if err = json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	h := envelope.Interfaces.Handoff
	instructions, err := wenCompactV1(h.Instruction)
	if err != nil {
		return err
	}
	var op struct {
		Opcode     int    `json:"opcode"`
		Name       string `json:"name"`
		DataLength int    `json:"dataLength"`
		Accounts   []struct {
			Role     string `json:"role"`
			Signer   *bool  `json:"signer"`
			Writable *bool  `json:"writable"`
		} `json:"accounts"`
	}
	if err = json.Unmarshal(instructions, &op); err != nil {
		return err
	}
	if !wenReservationHashV1(h.SourceDigest) || !wenReservationHashV1(h.ContractDigest) || h.Schema != "wen.owner-claim-handoff-candidate.v1" || h.PortableClient != "client/staking-claim-client.mjs" || h.Operation != "native-staking-claim" || op.Opcode != 42 || op.Name != "staking_release::claim_instruction" || op.DataLength != 17 || len(op.Accounts) != 13 || wenHashV1(instructions) != h.InstructionDigest || h.SourceDigest != object("source")["sourceDigest"] || h.ContractDigest != object("interfaces")["contractDigest"] {
		return errors.New("native claim instruction binding")
	}
	roles := []string{"owner", "sale", "activation", "receipt", "source", "cohort", "history", "claim", "inventory", "destination", "satMint", "token2022Program", "systemProgram"}
	for j, a := range op.Accounts {
		w := j == 0 || j == 4 || j == 7 || j == 8 || j == 9
		if a.Role != roles[j] || a.Signer == nil || a.Writable == nil || *a.Signer != (j == 0) || *a.Writable != w {
			return errors.New("native claim account contract")
		}
	}
	var layout any
	if err = json.Unmarshal(h.PaidLayout, &layout); err != nil {
		return err
	}
	actualLayout, err := wenJSONV1(layout)
	if err != nil {
		return err
	}
	var expectedLayout any
	if err = json.Unmarshal([]byte(wenNativePaidLayoutV1), &expectedLayout); err != nil {
		return err
	}
	expectedBytes, _ := wenJSONV1(expectedLayout)
	if !bytes.Equal(actualLayout, expectedBytes) {
		return errors.New("native claim paid layout")
	}
	capability := struct {
		Operation         string          `json:"operation"`
		InstructionDigest string          `json:"instructionDigest"`
		PaidLayout        json.RawMessage `json:"paidLayout"`
		SourceDigest      string          `json:"sourceDigest"`
		ContractDigest    string          `json:"contractDigest"`
		PortableClient    string          `json:"portableClient"`
	}{h.Operation, h.InstructionDigest, h.PaidLayout, h.SourceDigest, h.ContractDigest, h.PortableClient}
	encoded, err := wenJSONV1(capability)
	if err != nil {
		return err
	}
	digest := wenHashV1(bytes.TrimSuffix(encoded, []byte{'\n'}))
	if digest != p.CapabilitySHA256 || h.CapabilityDigest != digest || object("componentGenerations")["ownerClaimCapability"] != digest || object("runtimeCompatibility")["ownerClaimCapability"] != digest {
		return errors.New("descriptor capability not acknowledged")
	}
	deployment, _ := object("deployment")["ownerClaim"].(map[string]any)
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

const wenNativePaidLayoutV1 = `{"source":"src/staking_release.rs","magic":"WENNSCL1","version":1,"length":112,"review":"SOURCE_REVIEWED_FIELDS","fields":[["magic",0,8,"bytes"],["version",8,1,"u8"],["reserved",9,2,"zero"],["bump",11,1,"u8"],["padding",12,4,"zero"],["source",16,32,"pubkey"],["owner",48,32,"pubkey"],["gross",80,8,"u64le"],["net",88,8,"u64le"],["weight",96,8,"u64le"],["day",104,8,"u64le"]]}`
