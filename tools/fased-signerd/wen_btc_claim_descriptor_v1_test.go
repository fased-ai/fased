package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestWENBTCClaimDescriptor(t *testing.T) {
	for _, mode := range []string{"ok", "opcode", "role", "writable", "operations", "deployment", "capability", "source"} {
		t.Run(mode, func(t *testing.T) {
			b, pins := btcClaimDescriptorFixture(t, mode)
			if e := validateWENBTCClaimDescriptorV1(b, pins); (e == nil) != (mode == "ok") {
				t.Fatal(e)
			}
		})
	}
}

func btcClaimDescriptorFixture(t *testing.T, mode string) ([]byte, wenStakingPinsV1) {
	raw, p := stakingDescriptorFixture(t)
	var d map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if e := decoder.Decode(&d); e != nil {
		t.Fatal(e)
	}
	interfaces := d["interfaces"].(map[string]any)
	h := interfaces["stakingChangeHandoff"].(map[string]any)
	delete(interfaces, "stakingChangeHandoff")
	interfaces["btcClaimHandoff"] = h
	h["schema"] = "wen.btc-claim-handoff-candidate.v1"
	h["portableClient"] = "client/btc-claim-preparation.mjs"
	h["operations"] = []string{"fee-staking-btc-claim", "mining-staking-btc-claim"}
	roles := []string{"owner", "sale", "activation", "tranche", "cohort", "history", "settlement", "fallbackClaim", "paid", "btcVault", "destination", "routeAuthority", "btcMint", "systemProgram", "tokenProgram"}
	for n, entry := range h["instructions"].([]any) {
		op := entry.(map[string]any)
		op["opcode"] = []int{53, 101}[n]
		op["dataLength"] = []int{17, 25}[n]
		op["name"] = []string{"btc_settlement::claim_instruction", "btc_settlement::claim_instruction_for_source"}[n]
		for j, a := range op["accounts"].([]any) {
			v := a.(map[string]any)
			v["role"] = roles[j]
			v["signer"] = j == 0
			v["writable"] = j == 0 || j == 6 || j == 8 || j == 9 || j == 10
		}
	}
	dep := d["deployment"].(map[string]any)
	dep["btcClaim"] = dep["stakingChange"]
	delete(dep, "stakingChange")
	op := h["instructions"].([]any)[0].(map[string]any)
	switch mode {
	case "opcode":
		op["opcode"] = 34
	case "role":
		op["accounts"].([]any)[1].(map[string]any)["role"] = "owner"
	case "writable":
		op["accounts"].([]any)[1].(map[string]any)["writable"] = true
	case "operations":
		h["operations"] = []string{"deposit", "requestExit"}
	case "deployment":
		dep["btcClaim"].(map[string]any)["deploymentSlot"] = "51"
	case "source":
		h["sourceDigest"] = p.CodeSHA256
	}
	ins, _ := json.Marshal(h["instructions"])
	h["instructionDigest"] = wenHashV1(ins)
	cap := struct {
		Operations        any `json:"operations"`
		InstructionDigest any `json:"instructionDigest"`
		SourceDigest      any `json:"sourceDigest"`
		ContractDigest    any `json:"contractDigest"`
		PortableClient    any `json:"portableClient"`
	}{h["operations"], h["instructionDigest"], h["sourceDigest"], h["contractDigest"], h["portableClient"]}
	b, _ := wenJSONV1(cap)
	pins := p
	pins.CapabilitySHA256 = wenHashV1(bytes.TrimSuffix(b, []byte{'\n'}))
	h["capabilityDigest"] = pins.CapabilitySHA256
	for _, section := range []string{"componentGenerations", "runtimeCompatibility"} {
		d[section].(map[string]any)["btcClaimCapability"] = pins.CapabilitySHA256
	}
	if mode == "capability" {
		d["runtimeCompatibility"].(map[string]any)["btcClaimCapability"] = "wrong"
	}
	delete(d, "descriptorDigest")
	b, _ = wenJSONV1(d)
	d["descriptorDigest"] = "sha256:" + wenHashV1(b)
	b, _ = wenJSONV1(d)
	pins.DescriptorSHA256 = wenHashV1(b)
	return b, pins
}
