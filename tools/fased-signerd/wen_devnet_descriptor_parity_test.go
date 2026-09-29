package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"strings"
	"testing"
)

// Explicit external fixture for current Devnet interface parity. Does not write
// admission files, create wallets, start a signer, or send transactions.
func TestWENDevnetDescriptorParity(t *testing.T) {
	path := os.Getenv("WEN_DEVNET_DESCRIPTOR_TEST")
	if path == "" {
		t.Skip("explicit compatibility fixture required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if wenHashV1(raw) != os.Getenv("WEN_DEVNET_DESCRIPTOR_SHA256") {
		t.Fatal("fixture pin mismatch")
	}
	var d struct {
		ComponentGenerations map[string]string `json:"componentGenerations"`
	}
	if err = json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	authority := solana.MustPublicKeyFromBase58("C9y1TCfmUh3DbCpec1GvuuWdV4EYcE2N23tsgcUbgJ4N")
	// Independent current-candidate pins. The external descriptor hash above
	// guards the fixture bytes; these values must match the installed readback.
	p := wenStakingPinsV1{ProgramID: "GC4KiyyAkr3Gwp5pQXQMqoDinrRYtQq9BwZU2cVHDMaQ", Genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", DescriptorSHA256: wenHashV1(raw), CodeSHA256: "536eb53242cef9daf016e6017ec90c4536abb0e0647e3a2042920a4dd95e0aa6", DeploymentSlot: 505300574, UpgradeAuthority: &authority}
	consumers := map[string]func([]byte, wenStakingPinsV1) error{"ownerClaim": validateWENNativeClaimDescriptorV1, "btcClaim": validateWENBTCClaimDescriptorV1, "stakingChange": validateWENStakingDescriptorV1, "withdrawal": validateWENWithdrawalDescriptorV1}
	for role, validate := range consumers {
		t.Run(role, func(t *testing.T) {
			pins := p
			pins.CapabilitySHA256 = d.ComponentGenerations[role+"Capability"]
			if err := validate(raw, pins); err != nil {
				t.Fatal(err)
			}
			pins.CapabilitySHA256 = strings.Repeat("0", 64)
			if validate(raw, pins) == nil {
				t.Fatal("substituted capability accepted")
			}
			pins = p
			pins.CapabilitySHA256 = d.ComponentGenerations[role+"Capability"]
			pins.DeploymentSlot++
			if validate(raw, pins) == nil {
				t.Fatal("substituted deployment accepted")
			}
		})
	}
}
