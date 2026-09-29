package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in subprocess harness. Compiled only into Go tests; no production opcode.
func TestWENCampaignBrowserSigner(t *testing.T) {
	dir := os.Getenv("WEN_BROWSER_TEST_DIR")
	if dir == "" {
		t.Skip("browser harness only")
	}
	origin := os.Getenv("WEN_BROWSER_TEST_ORIGIN")
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1") {
		t.Fatal("non-loopback test origin")
	}
	op, mode := os.Getenv("WEN_BROWSER_TEST_OPERATION"), "ok"
	if op == "" {
		op = "stop"
	}
	if op == "bond-purchase" {
		service, client, review, draft := bondPurchaseBrowserSignerFixtureV2(t, parsed.Hostname(), origin)
		if e := os.WriteFile(filepath.Join(dir, "draft-sha256"), []byte(draft), 0600); e != nil {
			t.Fatal(e)
		}
		serveWENOwnerBrowserSigner(t, dir, review, service, nil, func() int { return client.sends }, wenBrowserOwnerRPC{bondPurchase: client})
		return
	}
	if op == "bond-claim" {
		service, client, review, draft := bondClaimBrowserSignerFixtureV2(t, parsed.Hostname(), origin)
		if e := os.WriteFile(filepath.Join(dir, "draft-sha256"), []byte(draft), 0600); e != nil {
			t.Fatal(e)
		}
		serveWENOwnerBrowserSigner(t, dir, review, service, nil, func() int { return client.sends }, wenBrowserOwnerRPC{bondClaim: client})
		return
	}
	if op == "buy" {
		service, client, review, draft := marketBrowserSignerFixtureV1(t, parsed.Hostname(), origin)
		if e := os.WriteFile(filepath.Join(dir, "draft-sha256"), []byte(draft), 0600); e != nil {
			t.Fatal(e)
		}
		serveWENCampaignBrowserSigner(t, dir, review, service, nil, func() int { return client.sends }, client)
		return
	}
	if op == "claim-stake" {
		service, client, review, _ := directStakeSignerFixture(t, parsed.Hostname(), origin)
		serveWENCampaignBrowserSigner(t, dir, review, service, client, func() int { return client.sends })
		return
	}
	if op != "stop" && op != "setup" && op != "policy" && op != "claim" {
		t.Fatal("unsupported browser fixture operation")
	}
	setupRPC, setupPins, setupRequest, _ := campaignSetupRPCFixture(t, "ok")
	store, keys := openTestSignerV2(t)
	program := solana.NewWallet().PublicKey()
	issuer := solana.NewWallet().PublicKey()
	economy := campaignAccountingTestSale(program, issuer)
	if op == "setup" {
		program, economy = setupRequest.Program, setupRequest.Economy
	}
	record, old := createTestSignerWalletV2(t, store, keys, "miner", economy.String(), 10000, 20000)
	store.now = time.Now
	wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
	policy, err := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenCampaignOperationV1(op)}, Programs: []string{program.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{economy.String()}, MaxPerTx: "10000", MaxDaily: "20000"}}}, old.Version)
	if err != nil {
		t.Fatal(err)
	}
	mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), economy[:]}, program)
	window := campaignAccountingTestWindow(program, issuer, mint)
	pos, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), wallet[:], mint[:]}, program)
	data := make([]byte, 256)
	copy(data, "WENRPOS2")
	data[8] = 1
	copy(data[16:], wallet[:])
	copy(data[48:], issuer[:])
	copy(data[80:], mint[:])
	copy(data[192:], window[:])
	snapshot := wenCampaignPositionV1{Slot: 110, ReferenceSlot: 111, Address: pos, Owner: program, Data: data, Lamports: 1100, Rent: 100}
	action := wenCampaignOwnerActionV1{Operation: op, Program: program, Economy: economy, Position: pos, Amount: 1000}
	if op == "policy" {
		configureWENCampaignPolicyFixture(&action, &snapshot, issuer, 1000)
	}
	if op == "stop" {
		action.Amount = 0
	}
	var claim *wenCampaignClaimSnapshotV1
	if op == "claim" {
		c := campaignClaimExecutionSnapshot(program, economy, wallet)
		claim = &c
		action.Claim = campaignClaimRequestFromSnapshot(c)
		action.Amount = 0
		snapshot = campaignClaimPositionV1(c)
	}
	if op == "stop" || op == "policy" {
		reader := &campaignReadFake{wenReadRPCFake: &wenReadRPCFake{t: t}, accounting: campaignAccountingTestAccounts(t, program, economy, issuer, window, mint)}
		hash, e := readWENCampaignAccountingV1(context.Background(), reader, program, economy, issuer, window, mint, 110, 132)
		if e != nil {
			t.Fatal(e)
		}
		snapshot.AccountingSHA256 = hex.EncodeToString(hash[:])
	}
	var prepared *wenCampaignPreparedV1
	pins := signerWENBTCPinsV1{}
	if op == "setup" {
		action.Amount, action.Setup = setupRequest.Terms.Deposit, &setupRequest
		prepared, err = prepareWENCampaignOwnerV1(context.Background(), setupRPC, setupPins, action, wallet, 100, 132, 32, 5000, nil)
		pins = setupPins
	} else {
		var ix solana.Instruction
		var e error
		if claim != nil {
			ix, _, e = buildWENCampaignClaimV1(*claim)
		} else {
			ix, e = buildWENCampaignOwnerV1(action, wallet, snapshot)
		}
		if e != nil {
			t.Fatal(e)
		}
		hash := solana.Hash(solana.NewWallet().PublicKey())
		tx, e := solana.NewTransaction([]solana.Instruction{ix}, hash, solana.TransactionPayer(wallet))
		if e != nil {
			t.Fatal(e)
		}
		tx.Message.SetVersion(solana.MessageVersionV0)
		msg, e := tx.Message.MarshalBinary()
		if e != nil {
			t.Fatal(e)
		}
		prepared = &wenCampaignPreparedV1{message: msg, blockhash: hash, position: snapshot, claim: claim, fee: 4500, currentHeight: 100, lastValidHeight: 200}
		pins = signerWENBTCPinsV1{ProgramID: program.String(), Genesis: hash.String(), CodeSHA256: wenHashV1([]byte("fixture")), DeploymentSlot: 50}
	}
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := newWENCampaignReviewV1("review-request-001", "miner", policy.Hash, pins, action, wallet, prepared, 132, 5000)
	if err != nil {
		t.Fatal(err)
	}
	review, err := store.storeWENCampaignReviewV1(artifact)
	if err != nil {
		t.Fatal(err)
	}

	ad, _ := artifact.digest()
	root := filepath.Join(filepath.Dir(store.db.Path()), "wen-campaign", wenHashV1([]byte("miner")))
	if err = os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	entry := wenCampaignAdmissionV1{Version: 1, WalletID: "miner", ArtifactDigest: ad}
	if mode == "wrong-admission" {
		entry.ArtifactDigest = wenHashV1([]byte("wrong"))
	}
	raw, _ := json.Marshal(entry)
	if mode != "missing-admission" {
		if err = os.WriteFile(filepath.Join(root, ad+".json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if mode == "symlink-admission" {
		path := filepath.Join(root, ad+".json")
		if err = os.Rename(path, path+".target"); err != nil {
			t.Fatal(err)
		}
		if err = os.Symlink(path+".target", path); err != nil {
			t.Fatal(err)
		}
	}
	_ = review
	debit, _ := artifact.debit()
	for _, scope := range []string{wenMiningNativeScopeV1("miner", pins.Genesis), wenCampaignLaunchScopeV1(artifact)} {
		if err = store.configureWENBudgetV1(scope, debit); err != nil {
			t.Fatal(err)
		}
	}
	authService, err := newSignerWebAuthnServiceV2(store, parsed.Hostname(), origin)
	if err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: store, keys: keys, webauthn: authService}
	var client wenCampaignExecutionRPCV1
	var sends func() int
	if op == "setup" {
		c := &campaignSetupExecutionFake{campaignSetupRPCFake: setupRPC, store: store, artifact: artifact, outcome: "ok"}
		client, sends = c, func() int { return c.sends }
	} else {
		c := campaignExecutionFixture(t, artifact, store, "ok")
		client, sends = c, func() int { return c.sends }
	}
	keys.genesisHash = func(string) (string, error) { return pins.Genesis, nil }
	endpoint := "https://browser-fixture.invalid"
	if _, err = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); err != nil {
		t.Fatal(err)
	}
	serveWENCampaignBrowserSigner(t, dir, review, service, client, sends)
}

func serveWENCampaignBrowserSigner(t *testing.T, dir string, review signerReviewV2, service *signerServiceV2, client wenCampaignExecutionRPCV1, sends func() int, market ...wenMarketExecutionRPCV1) {
	var peer wenBrowserOwnerRPC
	if len(market) == 1 {
		peer.market = market[0]
	}
	serveWENOwnerBrowserSigner(t, dir, review, service, client, sends, peer)
}

type wenBrowserOwnerRPC struct {
	bondPurchase wenBondPurchaseExecutionRPCV2
	market       wenMarketExecutionRPCV1
	bondClaim    wenBondClaimExecutionRPCV2
}

func serveWENOwnerBrowserSigner(t *testing.T, dir string, review signerReviewV2, service *signerServiceV2, client wenCampaignExecutionRPCV1, sends func() int, peer wenBrowserOwnerRPC) {
	cfg := signerConfig{stateDBPath: service.store.db.Path(), chains: []string{"solana"}}
	socketPath := filepath.Join(dir, "signer.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err = os.Chmod(socketPath, 0600); err != nil {
		t.Fatal(err)
	}
	ready, _ := json.Marshal(review)
	if err = os.WriteFile(filepath.Join(dir, "ready.json"), ready, 0600); err != nil {
		t.Fatal(err)
	}
	events := []string{}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		listener.(*net.UnixListener).SetDeadline(time.Now().Add(time.Second))
		conn, e := listener.Accept()
		if e != nil {
			if _, e = os.Stat(filepath.Join(dir, "stop")); e == nil {
				break
			}
			continue
		}
		conn.SetDeadline(time.Now().Add(10 * time.Second))
		var req request
		raw, e := bufio.NewReader(conn).ReadBytes('\n')
		if e != nil {
			conn.Close()
			continue
		}
		if e = json.Unmarshal(raw, &req); e != nil {
			conn.Close()
			continue
		}
		var body struct {
			Action string `json:"action"`
		}
		json.Unmarshal(req.Request, &body)
		events = append(events, req.Op+":"+body.Action)
		var response []byte
		switch req.Op {
		case "v2.wenBondPurchase.review.prepare":
			if peer.bondPurchase == nil {
				e = errors.New("Bond purchase fixture unavailable")
				break
			}
			response, e = marshalSignerResultV2(review)
		case "v2.wenBondPurchase.journey":
			if peer.bondPurchase == nil {
				e = errors.New("Bond purchase fixture unavailable")
				break
			}
			response, e = service.bondPurchaseApplicationWithFactoryV2(context.Background(), req, cfg, func(string) wenBondPurchaseExecutionRPCV2 { return peer.bondPurchase })
		case "v2.wenBondClaim.review.prepare":
			if peer.bondClaim == nil {
				e = errors.New("Bond claim fixture unavailable")
				break
			}
			response, e = marshalSignerResultV2(review)
		case "v2.wenBondClaim.journey":
			if peer.bondClaim == nil {
				e = errors.New("Bond claim fixture unavailable")
				break
			}
			response, e = service.bondClaimApplicationWithFactoryV2(context.Background(), req, cfg, func(string) wenBondClaimExecutionRPCV2 { return peer.bondClaim })
		case "v2.wenMarket.review.prepare":
			if peer.market == nil {
				e = errors.New("market browser fixture unavailable")
				break
			}
			response, e = marshalSignerResultV2(review)
		case "v2.wenMarket.journey":
			if peer.market == nil {
				e = errors.New("market browser fixture unavailable")
				break
			}
			response, e = service.marketApplicationWithFactoryV1(context.Background(), req, cfg, func(string) wenMarketExecutionRPCV1 { return peer.market })
		case "v2.wenCampaign.review.prepare":
			response, e = marshalSignerResultV2(review)
		case "v2.wenCampaign.journey":
			response, e = service.campaignApplicationWithFactoryV1(context.Background(), req, cfg, func(string) wenCampaignExecutionRPCV1 { return client })
		case "v2.webauthn.registration.begin", "v2.webauthn.registration.finish":
			response, e = service.handle(req, cfg, true)
		case "v2.review.authorization.begin", "v2.review.authorization.finish":
			response, e = service.handle(req, cfg, false)
			if e == nil && req.Op == "v2.review.authorization.finish" {
				events = append(events, "cryptographic-assertion-verified")
			}
		default:
			conn.Close()
			continue
		}
		if e != nil {
			response, _ = json.Marshal(map[string]any{"ok": false, "error": e.Error()})
		}
		if body.Action == "execute" && e == nil {
			response = []byte("{uncertain")
		}
		conn.Write(append(response, '\n'))
		conn.Close()
	}
	if sends() != 1 {
		t.Errorf("expected one simulated send, got %d", sends())
	}
	result, _ := json.Marshal(events)
	os.WriteFile(filepath.Join(dir, "events.json"), result, 0600)
}
