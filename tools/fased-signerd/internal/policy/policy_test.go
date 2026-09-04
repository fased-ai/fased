package policy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

const policyTestKey = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" // pragma: allowlist secret

func TestPolicyTypeJSONShapeAndCanonicalEmptyArrays(t *testing.T) {
	policy, err := Normalize(Policy{WalletID: " Agent Primary ", Role: " AGENT "})
	if err != nil {
		t.Fatal(err)
	}
	if policy.WalletID != "agent_primary" || policy.Hash == "" {
		t.Fatalf("policy was not canonicalized: %#v", policy)
	}
	if policy.Operations == nil || policy.Programs == nil || policy.Assets == nil {
		t.Fatalf("canonical policy did not preserve empty arrays: %#v", policy)
	}
	withoutHash := policy
	withoutHash.Hash = ""
	raw, err := json.Marshal(withoutHash)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"walletId":"agent_primary","role":"agent","version":0,"operations":[],"programs":[],"assets":[],"hash":""}`
	if string(raw) != want {
		t.Fatalf("policy JSON shape changed\n got: %s\nwant: %s", raw, want)
	}

	assetRaw, err := json.Marshal(Asset{Asset: "solana:native", Destinations: []string{}, MaxPerTx: "1", MaxDaily: "1"})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"asset":"solana:native","destinations":[],"maxPerTx":"1","maxDaily":"1"}`; string(assetRaw) != want {
		t.Fatalf("asset JSON shape changed\n got: %s\nwant: %s", assetRaw, want)
	}
}

func TestNormalizeGoldenAndAllAssetFamilies(t *testing.T) {
	input := Policy{
		WalletID: " Agent Primary ", Role: " AGENT ", Version: 9, BaselineVersion: 3, TypedSATPrograms: true,
		Operations: []string{" transfer ", "bond", "transfer"},
		Programs:   []string{policyTestKey, FederationBondProgramDomain, " " + policyTestKey + " ", FederationBondProgramDomain},
		Assets: []Asset{
			{Asset: "agent-capital:action", Destinations: []string{solana.SystemProgramID.String()}, MaxPerTx: "1", MaxDaily: "1"},
			{Asset: " solana:spl:" + policyTestKey, Destinations: []string{policyTestKey, solana.SystemProgramID.String(), policyTestKey}, MaxPerTx: "0002", MaxDaily: "0003"},
			{Asset: "sat:mint:" + policyTestKey, Destinations: []string{solana.SystemProgramID.String()}, MaxPerTx: "4", MaxDaily: "5"},
			{Asset: "sat:capital:lamports", Destinations: []string{solana.SystemProgramID.String()}, MaxPerTx: "6", MaxDaily: "7"},
			{Asset: "sat:action", Destinations: []string{solana.SystemProgramID.String()}, MaxPerTx: "8", MaxDaily: "9", TypedSATDestinations: true},
			{Asset: "solana:native", Destinations: []string{solana.SystemProgramID.String()}, MaxPerTx: "10", MaxDaily: "11", ReviewedDestinations: true},
			{Asset: "federation:bond-challenge", Destinations: []string{solana.SystemProgramID.String()}, MaxPerTx: "1", MaxDaily: "1"},
		},
	}
	got, err := Normalize(input)
	if err != nil {
		t.Fatal(err)
	}
	if got.Hash != "sha256:3a020d772af4855845a6dd9cf0a7f603fe662a52c905ced6f509ae06a050c357" {
		t.Fatalf("canonical policy hash changed: %s", got.Hash)
	}
	if !reflect.DeepEqual(got.Operations, []string{"bond", "transfer"}) || !reflect.DeepEqual(got.Programs, []string{policyTestKey, FederationBondProgramDomain}) {
		t.Fatalf("operations/programs were not sorted and deduplicated: %#v", got)
	}
	if got.Assets[0].Asset != "agent-capital:action" || got.Assets[6].Asset != "solana:spl:"+policyTestKey {
		t.Fatalf("assets were not sorted: %#v", got.Assets)
	}
	if got.Assets[6].MaxPerTx != "2" || got.Assets[6].MaxDaily != "3" || !reflect.DeepEqual(got.Assets[6].Destinations, []string{solana.SystemProgramID.String(), policyTestKey}) {
		t.Fatalf("asset was not canonicalized: %#v", got.Assets[6])
	}

	permuted := input
	permuted.Operations = []string{"transfer", "bond"}
	permuted.Programs = []string{FederationBondProgramDomain, policyTestKey}
	permuted.Assets = append([]Asset(nil), input.Assets...)
	for left, right := 0, len(permuted.Assets)-1; left < right; left, right = left+1, right-1 {
		permuted.Assets[left], permuted.Assets[right] = permuted.Assets[right], permuted.Assets[left]
	}
	again, err := Normalize(permuted)
	if err != nil {
		t.Fatal(err)
	}
	if got.Hash != again.Hash || !reflect.DeepEqual(got, again) {
		t.Fatalf("normalization is not deterministic\nfirst: %#v\nagain: %#v", got, again)
	}
}

func TestNormalizeWalletID(t *testing.T) {
	for input, want := range map[string]string{
		"": "default", "  AGENT Primary  ": "agent_primary", "--a__b--": "a_b", "___": "default", "MiXeD.123": "mixed_123",
	} {
		if got := NormalizeWalletID(input); got != want {
			t.Errorf("NormalizeWalletID(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeFailures(t *testing.T) {
	base := Policy{WalletID: "agent", Role: "agent", Operations: []string{}, Programs: []string{}, Assets: []Asset{}}
	tests := []struct {
		name string
		edit func(*Policy)
		want string
	}{
		{"wallet required", func(p *Policy) { p.WalletID = " " }, "walletId is required"},
		{"role", func(p *Policy) { p.Role = "operator" }, "policy role must be agent, mining, vault, profile, strategy, or keeper"},
		{"operation", func(p *Policy) { p.Operations = []string{" "} }, "policy operation cannot be empty"},
		{"program required", func(p *Policy) { p.Programs = []string{" "} }, "policy program is required"},
		{"program invalid", func(p *Policy) { p.Programs = []string{"not-a-key"} }, "invalid policy program"},
		{"unsupported asset", func(p *Policy) { p.Assets = []Asset{{Asset: "other", MaxPerTx: "1", MaxDaily: "1"}} }, `unsupported policy asset "other"`},
		{"invalid spl mint", func(p *Policy) { p.Assets = []Asset{{Asset: "solana:spl:not-a-key", MaxPerTx: "1", MaxDaily: "1"}} }, "invalid policy asset mint"},
		{"invalid SAT mint", func(p *Policy) { p.Assets = []Asset{{Asset: "sat:mint:not-a-key", MaxPerTx: "1", MaxDaily: "1"}} }, "invalid SAT policy asset mint"},
		{"duplicate asset", func(p *Policy) {
			p.Assets = []Asset{{Asset: "solana:native", MaxPerTx: "1", MaxDaily: "1"}, {Asset: "solana:native", MaxPerTx: "1", MaxDaily: "1"}}
		}, "duplicate policy asset solana:native"},
		{"destination required", func(p *Policy) {
			p.Assets = []Asset{{Asset: "solana:native", Destinations: []string{" "}, MaxPerTx: "1", MaxDaily: "1"}}
		}, "policy destination is required"},
		{"destination invalid", func(p *Policy) {
			p.Assets = []Asset{{Asset: "solana:native", Destinations: []string{"not-a-key"}, MaxPerTx: "1", MaxDaily: "1"}}
		}, "invalid policy destination"},
		{"per transaction positive", func(p *Policy) { p.Assets = []Asset{{Asset: "solana:native", MaxPerTx: "0", MaxDaily: "1"}} }, "policy maxPerTx must be a positive integer"},
		{"per transaction bound", func(p *Policy) {
			p.Assets = []Asset{{Asset: "solana:native", MaxPerTx: "18446744073709551616", MaxDaily: "1"}}
		}, "policy maxPerTx exceeds uint64"},
		{"daily positive", func(p *Policy) { p.Assets = []Asset{{Asset: "solana:native", MaxPerTx: "1", MaxDaily: "0"}} }, "policy maxDaily must be a positive integer"},
		{"daily bound", func(p *Policy) {
			p.Assets = []Asset{{Asset: "solana:native", MaxPerTx: "1", MaxDaily: "18446744073709551616"}}
		}, "policy maxDaily exceeds uint64"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := base
			test.edit(&input)
			_, err := Normalize(input)
			if err == nil || err.Error() != test.want {
				t.Fatalf("Normalize() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestRequireTightening(t *testing.T) {
	current := Policy{
		WalletID: "agent", Role: "agent", BaselineVersion: 4, TypedSATPrograms: true,
		Operations: []string{"one", "two"}, Programs: []string{policyTestKey, FederationBondProgramDomain},
		Assets: []Asset{{Asset: "solana:native", Destinations: []string{solana.SystemProgramID.String(), policyTestKey}, MaxPerTx: "10", MaxDaily: "20"}},
	}
	clone := func() Policy {
		candidate := current
		candidate.Operations = append([]string(nil), current.Operations...)
		candidate.Programs = append([]string(nil), current.Programs...)
		candidate.Assets = append([]Asset(nil), current.Assets...)
		candidate.Assets[0].Destinations = append([]string(nil), current.Assets[0].Destinations...)
		return candidate
	}
	if candidate := clone(); RequireTightening(current, candidate) != nil {
		t.Fatalf("unchanged policy should be accepted")
	}
	tests := []struct {
		name string
		edit func(*Policy)
		want string
	}{
		{"wallet identity", func(p *Policy) { p.WalletID = "other" }, "cannot alter wallet identity or role"},
		{"role", func(p *Policy) { p.Role = "vault" }, "cannot alter wallet identity or role"},
		{"baseline version", func(p *Policy) { p.BaselineVersion++ }, "cannot alter signer-owned baseline authority"},
		{"typed SAT programs", func(p *Policy) { p.TypedSATPrograms = false }, "cannot alter signer-owned baseline authority"},
		{"operation", func(p *Policy) { p.Operations = append(p.Operations, "three") }, "cannot add operations"},
		{"program", func(p *Policy) { p.Programs = append(p.Programs, "new") }, "cannot add programs"},
		{"asset", func(p *Policy) { p.Assets = append(p.Assets, Asset{Asset: "sat:action", MaxPerTx: "1", MaxDaily: "1"}) }, "cannot add asset sat:action"},
		{"destination", func(p *Policy) { p.Assets[0].Destinations = append(p.Assets[0].Destinations, "new") }, "cannot add destinations for solana:native"},
		{"reviewed destination mode", func(p *Policy) { p.Assets[0].ReviewedDestinations = true }, "cannot add reviewed destinations for solana:native"},
		{"typed SAT destination mode", func(p *Policy) { p.Assets[0].TypedSATDestinations = true }, "cannot add typed SAT destinations for solana:native"},
		{"per transaction cap", func(p *Policy) { p.Assets[0].MaxPerTx = "11" }, "cannot raise per-transaction cap for solana:native"},
		{"daily cap", func(p *Policy) { p.Assets[0].MaxDaily = "21" }, "cannot raise daily cap for solana:native"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			baseline := current
			candidate := clone()
			test.edit(&candidate)
			err := RequireTightening(baseline, candidate)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("RequireTightening() error = %v, want %q", err, test.want)
			}
		})
	}
}
