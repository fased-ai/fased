package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWENMiningFundingPreparationDispatchV1(t *testing.T) {
	store, keys := openTestSignerV2(t)
	q, _, _ := miningFundingFixture(t)
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	req := request{Op: "v2.wenMiningFunding.prepare", WalletID: "staker", Request: raw}
	if err := mustValidate(req, cfg); err != nil {
		t.Fatal(err)
	}
	if !applicationUpdateGateReadOperations[req.Op] {
		t.Fatal("preview must remain read-only")
	}
	_, err = service.handle(req, cfg, false)
	if err == nil || !strings.Contains(err.Error(), "review") {
		t.Fatal("must reach protected review admission", err)
	}
	req.Request = append([]byte(`{"rpcUrl":"https://unexpected.invalid",`), raw[1:]...)
	if _, err = service.handle(req, cfg, false); err == nil {
		t.Fatal("caller RPC accepted")
	}
	req.WalletID = ""
	if err = mustValidate(req, cfg); err == nil {
		t.Fatal("missing wallet accepted")
	}
}
