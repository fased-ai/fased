package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestWENNativeClaimDescriptor(t *testing.T) {
	for _, mode := range []string{"ok", "opcode", "role", "writable", "operation", "layout", "deployment", "capability", "source"} {
		t.Run(mode, func(t *testing.T) {
			raw, p := nativeClaimDescriptorFixture(t, mode)
			e := validateWENNativeClaimDescriptorV1(raw, p)
			if (e == nil) != (mode == "ok") {
				t.Fatal(e)
			}
		})
	}
}
func nativeClaimDescriptorFixture(t *testing.T, mode string) ([]byte, wenStakingPinsV1) {
	raw, p := stakingDescriptorFixture(t)
	var d map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if e := dec.Decode(&d); e != nil {
		t.Fatal(e)
	}
	in := d["interfaces"].(map[string]any)
	h := in["stakingChangeHandoff"].(map[string]any)
	delete(in, "stakingChangeHandoff")
	in["ownerClaimHandoff"] = h
	h["schema"] = "wen.owner-claim-handoff-candidate.v1"
	h["portableClient"] = "client/staking-claim-client.mjs"
	h["operation"] = "native-staking-claim"
	delete(h, "operations")
	op := h["instructions"].([]any)[0].(map[string]any)
	delete(h, "instructions")
	h["instruction"] = op
	op["opcode"] = 42
	op["dataLength"] = 17
	op["name"] = "staking_release::claim_instruction"
	roles := []string{"owner", "sale", "activation", "receipt", "source", "cohort", "history", "claim", "inventory", "destination", "satMint", "token2022Program", "systemProgram"}
	accounts := []any{}
	for j, role := range roles {
		accounts = append(accounts, map[string]any{"role": role, "signer": j == 0, "writable": j == 0 || j == 4 || j == 7 || j == 8 || j == 9})
	}
	op["accounts"] = accounts
	var layout any
	json.Unmarshal([]byte(wenNativePaidLayoutV1), &layout)
	h["paidLayout"] = layout
	dep := d["deployment"].(map[string]any)
	dep["ownerClaim"] = dep["stakingChange"]
	delete(dep, "stakingChange")
	switch mode {
	case "opcode":
		op["opcode"] = 53
	case "role":
		accounts[1].(map[string]any)["role"] = "owner"
	case "writable":
		accounts[1].(map[string]any)["writable"] = true
	case "operation":
		h["operation"] = "deposit"
	case "layout":
		layout.(map[string]any)["length"] = 96
	case "deployment":
		dep["ownerClaim"].(map[string]any)["deploymentSlot"] = "51"
	case "source":
		h["sourceDigest"] = p.CodeSHA256
	}
	ins, _ := json.Marshal(op)
	h["instructionDigest"] = wenHashV1(ins)
	cap := struct {
		Operation         any `json:"operation"`
		InstructionDigest any `json:"instructionDigest"`
		PaidLayout        any `json:"paidLayout"`
		SourceDigest      any `json:"sourceDigest"`
		ContractDigest    any `json:"contractDigest"`
		PortableClient    any `json:"portableClient"`
	}{h["operation"], h["instructionDigest"], h["paidLayout"], h["sourceDigest"], h["contractDigest"], h["portableClient"]}
	b, _ := wenJSONV1(cap)
	p.CapabilitySHA256 = wenHashV1(bytes.TrimSuffix(b, []byte{'\n'}))
	h["capabilityDigest"] = p.CapabilitySHA256
	for _, section := range []string{"componentGenerations", "runtimeCompatibility"} {
		d[section].(map[string]any)["ownerClaimCapability"] = p.CapabilitySHA256
	}
	if mode == "capability" {
		d["runtimeCompatibility"].(map[string]any)["ownerClaimCapability"] = "wrong"
	}
	delete(d, "descriptorDigest")
	b, _ = wenJSONV1(d)
	d["descriptorDigest"] = "sha256:" + wenHashV1(b)
	b, _ = wenJSONV1(d)
	p.DescriptorSHA256 = wenHashV1(b)
	return b, p
}
