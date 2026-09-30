package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/gagliardetto/solana-go/rpc"
)

// Explicit read-only Devnet acceptance. No key, signer service, submit method,
// signature or account mutation is reachable. RPC credentials are never logged.
func TestWENMarketLiveDevnetRead(t *testing.T) {
	path := os.Getenv("FASED_WEN_MARKET_READ_CONFIG_FILE")
	if path == "" {
		t.Skip("explicit local Devnet read profile required")
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal("read profile unavailable")
	}
	var input struct {
		Pins    wenMarketBuyPinsV1
		Policy  wenMarketReadPolicyV1
		RPCFile string
	}
	if decodeSignerAdminStrictJSON(raw, &input) != nil || input.Pins.Profile != "devnet-synthetic-fixture" || !input.Policy.SyntheticReference {
		t.Fatal("Devnet test profile rejected")
	}
	endpoint, e := os.ReadFile(input.RPCFile)
	if e != nil {
		t.Fatal("RPC configuration unavailable")
	}
	url, e := normalizeSignerRPCURLV2(strings.TrimSpace(string(endpoint)), "configured Devnet reader")
	if e != nil {
		t.Fatal("RPC configuration rejected")
	}
	c := newSignerOwnedSolanaRPCClientV2(url)
	ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
	defer cancel()
	slot, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		t.Fatal("finalized slot read failed")
	}
	limits := wenMarketBuyLimitsV1{RequestedNet: 1000000000, MinimumNet: 1000000000, MaxCash: 1000000, MinimumSlot: slot, ExpiresSlot: slot + 32}

	var out wenMarketBuySnapshotV1
	var fee, units, lastValid uint64
	var messageHash string
	status := "PASS_AUTHENTICATED_DEVNET_BUY_READ"
	if os.Getenv("FASED_WEN_MARKET_PREPARE") == "1" {
		prepared, err := prepareWENMarketBuyV1(ctx, c, input.Pins, input.Policy, limits, 5000, 114762240, nil)
		if err != nil {
			t.Fatal("authenticated unsigned preparation failed; RPC error details withheld")
		}
		out = prepared.snapshot
		fee = prepared.fee
		units = prepared.units
		lastValid = prepared.lastValidHeight
		messageHash = wenHashV1(prepared.message)
		status = "PASS_AUTHENTICATED_DEVNET_BUY_UNSIGNED_PREPARATION"
	} else {
		out, e = readWENMarketBuyV1(ctx, c, input.Pins, input.Policy, limits)
		if e != nil {
			t.Fatal("authenticated Devnet Buy read failed; RPC error details withheld")
		}
	}
	result := struct {
		Status                                     string
		Snapshot                                   wenMarketBuySnapshotV1
		FeeLamports, ComputeUnits, LastValidHeight uint64
		MessageSHA256                              string
		Signatures, Sends                          int
	}{status, out, fee, units, lastValid, messageHash, 0, 0}
	b, _ := json.Marshal(result)
	t.Log(string(b))
	if output := os.Getenv("FASED_WEN_MARKET_READ_RESULT_FILE"); output != "" {
		if os.WriteFile(output, append(b, '\n'), 0600) != nil {
			t.Fatal("cannot retain acceptance result")
		}
	}
}
