package main

import (
	"context"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Explicitly opt-in read-only acceptance against the installed WEN successor.
// The RPC URL is read from a private file and never printed or stored here.
func TestWENBondClaimQ2DevnetRead(t *testing.T) {
	path := os.Getenv("WEN_Q2_DEVNET_RPC_FILE")
	if path == "" {
		t.Skip("set WEN_Q2_DEVNET_RPC_FILE for read-only Devnet acceptance")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("private Devnet RPC file unavailable")
	}
	endpoint := strings.TrimSpace(string(data))
	if endpoint == "" {
		t.Fatal("private Devnet RPC URL empty")
	}
	client := rpc.New(endpoint)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	slot, err := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		t.Fatal("finalized Devnet slot unavailable")
	}
	program := solana.MustPublicKeyFromBase58("GC4KiyyAkr3Gwp5pQXQMqoDinrRYtQq9BwZU2cVHDMaQ")
	authority := solana.MustPublicKeyFromBase58("C9y1TCfmUh3DbCpec1GvuuWdV4EYcE2N23tsgcUbgJ4N")
	pins := wenBondPinsV2{
		Profile:     "devnet-synthetic-fixture",
		Program:     program,
		Sale:        solana.MustPublicKeyFromBase58("5fNcJggJb3rSRpkXhiHmfh1sTr45QLmDfVniFzg6LykH"),
		Policy:      solana.MustPublicKeyFromBase58("CMLvgGmcRkjDWzy8SU4gTJ3hcPNu5CcnQ2oHkXWMHgc9"),
		Owner:       solana.MustPublicKeyFromBase58("E39YR8qG1BG2ggEv6iWGGaRFRdijEP2zU1fDUY5rEXwX"),
		Destination: solana.MustPublicKeyFromBase58("FV74LLTAycnJUC7h1J5w6xg9EgdwJDvWzzkzUyudtpWm"),
	}
	policy := wenBondReadPolicyV2{
		Deployment: signerWENBTCPinsV1{
			ProgramID:        program.String(),
			Genesis:          "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
			CodeSHA256:       "536eb53242cef9daf016e6017ec90c4536abb0e0647e3a2042920a4dd95e0aa6",
			DeploymentSlot:   505300574,
			UpgradeAuthority: &authority,
		},
		Nonce: 2026092811, MinimumNet: 1, MinimumSlot: slot,
		ExpiresSlot: slot + 32, MaxSlotLag: 32,
	}
	result, err := readWENBondClaimV2(ctx, client, pins, policy)
	if err != nil {
		t.Fatal("q2 finalized Bond claim read failed: ", strings.ReplaceAll(err.Error(), endpoint, "[rpc]"))
	}
	if result.Claim.ClaimedNet != 4426587301 || result.Claim.AvailableNet == 0 || hex.EncodeToString(result.Claim.QuoteSHA256[:]) != "1486459d76afb52eaf1c9d657eff14ef281ca0b0c2863640c83d207635f465b4" {
		t.Fatal("q2 claim right differs from retained finalized purchase and partial claim")
	}
	t.Logf("read-only q2 right slot=%d reference=%d claimed-net-atoms=%d available-net-atoms=%d state-sha256=%s", result.Slot, result.ReferenceSlot, result.Claim.ClaimedNet, result.Claim.AvailableNet, result.StateSHA256)
}
