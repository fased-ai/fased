package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Shared with the TypeScript transport tests. Regenerate explicitly; ordinary
// runs compare the checked-in bytes rather than rewriting expected evidence.
func TestWENBTCInspectionWireFixture(t *testing.T) {
	_, root, review, f := wenReviewFixture(t)
	_, _, _, wallet, _ := wenArtifactCase(t)
	result, err := inspectReviewedWENBTCV1(context.Background(), f, root, review, wallet, 180000, nil)
	if err != nil {
		t.Fatal(err)
	}
	a, payer, route, _, _ := wenAcquisitionFixture(t)
	data, keys, err := a.acquisitionInstruction(payer, route, 100)
	if err != nil {
		t.Fatal(err)
	}
	acquisition := review.Intent
	acquisition.Operation = "acquisition"
	acquisition.OfferSHA256 = wenHashV1(a.offer[:])
	second := signerWENBTCInspectionV1{Status: result.Status, Operation: "acquisition", DescriptorSHA256: acquisition.DescriptorSHA256, OfferSHA256: acquisition.OfferSHA256, Readback: signerWENBTCReadResultV1{Slot: 150, ReferenceSlot: 151, Now: 100, Data: data, Accounts: keys}}
	fixtures := []struct {
		Intent signerWENBTCIntentV1     `json:"intent"`
		Result signerWENBTCInspectionV1 `json:"result"`
	}{{review.Intent, result}, {acquisition, second}}
	raw, err := json.MarshalIndent(fixtures, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	path := "testdata/wen-btc-inspection-wire.json"
	if os.Getenv("WEN_UPDATE_WIRE_FIXTURE") == "1" {
		if err = os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(saved) != string(raw) {
		t.Fatal("Go/TypeScript inspection wire fixture drift")
	}
	// Avoid JavaScript precision loss even beyond 2^53.
	result.Readback.Slot = ^uint64(0)
	encoded, _ := json.Marshal(result)
	if !strings.Contains(string(encoded), `"slot":"18446744073709551615"`) {
		t.Fatal("slot must be encoded as decimal text")
	}
}

func TestWENBTCInspectionApplicationTransport(t *testing.T) {
	_, _, review, _ := wenReviewFixture(t)
	body, _ := json.Marshal(review.Intent)
	req := request{Op: "v2.wenBtc.inspect", WalletID: "buyer", Request: body}
	server, client := net.Pipe()
	defer client.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handleConn(server, signerConfig{chains: []string{"solana"}, stateDBPath: filepath.Join(t.TempDir(), "signer.db"), readOnly: true}, newRateLimiter(time.Minute, map[string]int{req.Op: 1}), &auditWriter{}, &signerServiceV2{}, false)
	}()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	raw, _ := json.Marshal(req)
	if _, err := client.Write(append(raw, '\n')); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, "configuration unavailable") || strings.Contains(line, "unsupported op") {
		t.Fatalf("inspection failed before protected admission: %s", line)
	}
	client.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("transport did not finish")
	}
}
