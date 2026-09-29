package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Same generated synthetic descriptor consumed by the portable retail clients.
// This is local fixture authority only, never an accepted deployment.
func withdrawalDescriptorFixture(t *testing.T) ([]byte, wenStakingPinsV1) {
	t.Helper()
	raw, err := os.ReadFile("testdata/wen-common-client-descriptor.json")
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Interfaces struct {
			H struct {
				Capability string `json:"capabilityDigest"`
			} `json:"withdrawalHandoff"`
		} `json:"interfaces"`
	}
	if err = json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	_, p := stakingDescriptorFixture(t)
	p.DescriptorSHA256 = wenHashV1(raw)
	p.CapabilitySHA256 = d.Interfaces.H.Capability
	return raw, p
}

// Recompute all advertised hashes, so shape tests cannot pass by merely detecting stale hashes.
func repinWithdrawalDescriptor(t *testing.T, d map[string]any, p wenStakingPinsV1) ([]byte, wenStakingPinsV1) {
	t.Helper()
	h := d["interfaces"].(map[string]any)["withdrawalHandoff"].(map[string]any)
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
	p.CapabilitySHA256 = wenHashV1(bytes.TrimSuffix(b, []byte{'\n'}))
	h["capabilityDigest"] = p.CapabilitySHA256
	d["componentGenerations"].(map[string]any)["withdrawalCapability"] = p.CapabilitySHA256
	d["runtimeCompatibility"].(map[string]any)["withdrawalCapability"] = p.CapabilitySHA256
	delete(d, "descriptorDigest")
	b, _ = wenJSONV1(d)
	d["descriptorDigest"] = "sha256:" + wenHashV1(b)
	b, _ = wenJSONV1(d)
	p.DescriptorSHA256 = wenHashV1(b)
	return b, p
}
func TestWENWithdrawalDescriptorV1(t *testing.T) {
	raw, p := withdrawalDescriptorFixture(t)
	if e := validateWENWithdrawalDescriptorV1(raw, p); e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"valid-repin", "missing-signer", "missing-writable", "opcode", "name", "length", "role", "signer", "writable", "source", "operations", "client", "deployment"} {
		t.Run(mode, func(t *testing.T) {
			var d map[string]any
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			if e := decoder.Decode(&d); e != nil {
				t.Fatal(e)
			}
			h := d["interfaces"].(map[string]any)["withdrawalHandoff"].(map[string]any)
			op := h["instructions"].([]any)[0].(map[string]any)
			account := op["accounts"].([]any)[1].(map[string]any)
			switch mode {
			case "missing-signer":
				delete(account, "signer")
			case "missing-writable":
				delete(account, "writable")
			case "opcode":
				op["opcode"] = 10
			case "name":
				op["name"] = "legacy"
			case "length":
				op["dataLength"] = 25
			case "role":
				account["role"] = "owner"
			case "signer":
				account["signer"] = true
			case "writable":
				account["writable"] = true
			case "source":
				h["sourceDigest"] = strings.Repeat("00", 32)
			case "operations":
				h["operations"] = []string{"mining", "requestExit"}
			case "client":
				h["portableClient"] = "client/mining.mjs"
			case "deployment":
				d["deployment"].(map[string]any)["withdrawal"].(map[string]any)["genesis"] = "wrong"
			}
			b, pins := repinWithdrawalDescriptor(t, d, p)
			e := validateWENWithdrawalDescriptorV1(b, pins)
			if (e == nil) != (mode == "valid-repin") {
				t.Fatal("unexpected repinned descriptor", e)
			}
		})
	}
	bad := append(append([]byte(nil), raw...), []byte(" {}")...)
	q := p
	q.DescriptorSHA256 = wenHashV1(bad)
	if validateWENWithdrawalDescriptorV1(bad, q) == nil {
		t.Fatal("trailing JSON accepted")
	}
	bad = append([]byte(`{"stage":"deployed-release",`), raw[1:]...)
	q.DescriptorSHA256 = wenHashV1(bad)
	if validateWENWithdrawalDescriptorV1(bad, q) == nil {
		t.Fatal("duplicate accepted")
	}
}
func TestWENWithdrawalAdmissionV1(t *testing.T) {
	raw, p := withdrawalDescriptorFixture(t)
	f := withdrawalReviewFixture(t)
	f.Intent.DescriptorSHA256 = p.DescriptorSHA256
	f.Intent.CapabilitySHA256 = p.CapabilitySHA256
	db := filepath.Join(t.TempDir(), "state.db")
	r := wenWithdrawalReviewV1{Version: 1, WalletID: "staker", WalletPublicKey: f.Wallet, Intent: f.Intent, Pins: p, MaxTotalCostLamports: 10000000, MaxSlotLag: 2}
	root := writeWithdrawalReviewFixture(t, db, r)
	if _, _, e := loadWENWithdrawalAdmissionV1(db, "staker", f.Intent); e == nil {
		t.Fatal("missing descriptor accepted")
	}
	path := filepath.Join(root, p.DescriptorSHA256)
	if e := os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := loadWENWithdrawalAdmissionV1(db, "staker", f.Intent); e != nil {
		t.Fatal(e)
	}
	raw[0] ^= 1
	if e := os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := loadWENWithdrawalAdmissionV1(db, "staker", f.Intent); e == nil {
		t.Fatal("changed descriptor accepted")
	}
}
