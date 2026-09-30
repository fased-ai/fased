package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func wenJoinedServiceFixture(t *testing.T) (*signerServiceV2, signerConfig, signerWENBTCReviewV1, *atomic.Int32) {
	return wenJoinedServiceCase(t, "acceptance", "")
}

func wenJoinedServiceCase(t *testing.T, operation, mutation string) (*signerServiceV2, signerConfig, signerWENBTCReviewV1, *atomic.Int32) {
	t.Helper()
	state, root, review, f := wenReviewFixture(t)
	store, err := openSignerStoreV2(state)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := openSignerKeyManagerV2(store, filepath.Join(filepath.Dir(state), "master.key"))
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { keys.Close(); store.Close() })
	wallet, _ := createTestSignerWalletV2(t, store, keys, "buyer", review.WalletPublicKey, 100, 500)
	pub := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	review.WalletPublicKey = wallet.PublicKey
	offer, err := readWENBTCObjectV1(root, review.Pins.OfferSHA256, 464)
	if err != nil {
		t.Fatal(err)
	}
	copy(offer[72:104], pub[:])
	now := uint64(time.Now().Unix())
	for i, n := range []uint64{now + 600, now + 1200, now + 1800} {
		binary.LittleEndian.PutUint64(offer[328+(14+i)*8:], n)
	}
	review.Pins.OfferSHA256 = wenHashV1(offer)
	review.Intent.OfferSHA256 = review.Pins.OfferSHA256
	if err = os.WriteFile(filepath.Join(root, review.Pins.OfferSHA256), offer, 0600); err != nil {
		t.Fatal(err)
	}
	a, err := loadWENBTCAcceptanceV1(root, review.Pins, review.Intent, pub, 150, now)
	if err != nil {
		t.Fatal(err)
	}
	// Admission scope excludes the buyer but includes expiry; retain the reviewed
	// fixture expiry by creating a new scope/address for this current-time case.
	admission := append([]byte(nil), f.page.Value[26].Data.GetBinary()...)
	binary.LittleEndian.PutUint64(admission[240:], now-172801)
	binary.LittleEndian.PutUint64(admission[248:], now-1)
	binary.LittleEndian.PutUint64(admission[256:], now+601)
	payload := []byte("wen-btc-sub-admission-scope-v1")
	for _, i := range []int{0, 3, 4, 5, 7, 8, 9} {
		payload = append(payload, a.keys[i][:]...)
	}
	payload = append(payload, admission[256:264]...)
	digest := sha256.Sum256(payload)
	adm, bump, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-sub-admission-v1"), digest[:]}, a.program)
	if err != nil {
		t.Fatal(err)
	}
	admission[11] = bump
	review.Pins.AdmissionAccount = adm.String()
	a.admission = adm
	_, roles, err := a.acceptanceInstruction(now)
	if err != nil {
		t.Fatal(err)
	}
	addresses := make([]solana.PublicKey, 0, 30)
	for _, r := range roles {
		addresses = append(addresses, solana.MustPublicKeyFromBase58(r.Pubkey))
	}
	addresses = append(addresses, f.addresses[27:]...)
	f.addresses = addresses
	source := append([]byte(nil), f.page.Value[1].Data.GetBinary()...)
	copy(source[32:64], pub[:])
	f.page.Value[1].Data = rpc.DataBytesOrJSONFromBytes(source)
	f.page.Value[26].Data = rpc.DataBytesOrJSONFromBytes(admission)
	clock := append([]byte(nil), f.page.Value[29].Data.GetBinary()...)
	binary.LittleEndian.PutUint64(clock[32:], now)
	f.page.Value[29].Data = rpc.DataBytesOrJSONFromBytes(clock)

	if operation == "acquisition" {
		acquired, _, route, _, _ := wenAcquisitionFixture(t)
		acquired.keys[2] = pub
		copy(acquired.offer[72:104], pub[:])
		for i, n := range []uint64{now - 1, now + 1200, now + 1800} {
			acquired.numbers[14+i] = n
			binary.LittleEndian.PutUint64(acquired.offer[328+(14+i)*8:], n)
		}
		nonce := make([]byte, 8)
		binary.LittleEndian.PutUint64(nonce, acquired.numbers[0])
		record, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-subscription-v1"), acquired.keys[0][:], pub[:], nonce}, acquired.program)
		if err != nil {
			t.Fatal(err)
		}
		stage := func(seed string) solana.PublicKey {
			k, _, err := solana.FindProgramAddress([][]byte{[]byte(seed), record[:]}, acquired.program)
			if err != nil {
				t.Fatal(err)
			}
			return k
		}
		acquired.keys[6] = stage("wen-btc-subscription-cash-v1")
		copy(acquired.offer[8+6*32:], acquired.keys[6][:])
		for i, seed := range map[int]string{2: "wen-btc-swap-v1", 3: "wen-btc-sub-route-cash-v1", 6: "wen-btc-sub-route-asset-v1"} {
			route.Accounts[i].Pubkey = stage(seed).String()
		}
		review.Intent.Operation = "acquisition"
		review.RouteValidity = &signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 156}
		review.Pins.OfferSHA256 = wenHashV1(acquired.offer[:])
		review.Intent.OfferSHA256 = review.Pins.OfferSHA256
		if err = os.WriteFile(filepath.Join(root, review.Pins.OfferSHA256), acquired.offer[:], 0600); err != nil {
			t.Fatal(err)
		}
		routeBytes, err := json.Marshal(route)
		if err != nil {
			t.Fatal(err)
		}
		review.RouteSHA256 = wenHashV1(routeBytes)
		if mutation == "route-stale" {
			review.RouteValidity.ObservedSlot = 148
		}
		if mutation == "route-expires-during" {
			review.RouteValidity.ExpiresSlot = 155
		}
		if mutation == "route-tampered" {
			routeBytes = append(routeBytes, ' ')
		}
		if err = os.WriteFile(filepath.Join(root, review.RouteSHA256), routeBytes, 0600); err != nil {
			t.Fatal(err)
		}
		_, roles, err := acquired.acquisitionInstruction(pub, route, now)
		if err != nil {
			t.Fatal(err)
		}
		addresses = nil
		indices := map[solana.PublicKey]int{}
		for _, role := range roles {
			k := solana.MustPublicKeyFromBase58(role.Pubkey)
			if _, exists := indices[k]; !exists {
				indices[k] = len(addresses)
				addresses = append(addresses, k)
			}
		}
		addresses = append(addresses, f.addresses[27:]...)
		page := &rpc.GetMultipleAccountsResult{RPCContext: f.page.RPCContext, Value: make([]*rpc.Account, len(addresses))}
		copy(page.Value[len(addresses)-3:], f.page.Value[27:])
		funded, cash, reserve, working := wenFundedAccounts(t, acquired)
		binary.LittleEndian.PutUint64(funded.Data[120:], now-10)
		if mutation == "consumed" {
			funded.Data[9] = 1
		}
		if mutation == "underfunded" {
			binary.LittleEndian.PutUint64(cash.Data[64:], acquired.numbers[10]+acquired.numbers[12]-1)
		}
		for _, account := range []*signerWENBTCAccountV1{funded, cash, reserve, working} {
			page.Value[indices[account.Address]] = &rpc.Account{Owner: account.Owner, Executable: account.Executable, Data: rpc.DataBytesOrJSONFromBytes(account.Data)}
		}
		f.page = page
		f.addresses = addresses
	}

	tableKey := solana.PublicKey{99}
	tableBytes := make([]byte, 56+(len(addresses)-3)*32)
	binary.LittleEndian.PutUint32(tableBytes, 1)
	binary.LittleEndian.PutUint64(tableBytes[4:], ^uint64(0))
	binary.LittleEndian.PutUint64(tableBytes[12:], 149)
	for i, k := range addresses[:len(addresses)-3] {
		copy(tableBytes[56+i*32:], k[:])
	}
	preparationJSON, _ := json.Marshal(map[string]any{"computeUnits": 200000, "lookups": []map[string]string{{"address": tableKey.String(), "sha256": wenHashV1(tableBytes)}}})
	review.Preparation = &signerWENBTCPreparationReviewV1{}
	if err = json.Unmarshal(preparationJSON, review.Preparation); err != nil {
		t.Fatal(err)
	}
	writeWENReviewTest(t, root, review)
	calls := &atomic.Int32{}
	slotReads := &atomic.Int32{}
	rpcServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var in struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		calls.Add(1)
		var result any
		switch in.Method {
		case "getGenesisHash":
			result = review.Pins.Genesis
		case "getSlot":
			result = uint64(151)
			if slotReads.Add(1) > 1 {
				result = uint64(154)
			}
		case "getLatestBlockhash":
			result = &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 153}}, Value: &rpc.LatestBlockhashResult{Blockhash: solana.Hash{1}, LastValidBlockHeight: 20}}
		case "getFeeForMessage":
			result = map[string]any{"context": map[string]any{"slot": 154}, "value": 5000}
		case "getMinimumBalanceForRentExemption":
			result = uint64(100)
		case "getBalance":
			result = map[string]any{"context": map[string]any{"slot": 154}, "value": 10000000}
		case "simulateTransaction":
			var params []json.RawMessage
			json.Unmarshal(in.Params, &params)
			var opts struct {
				SigVerify  bool   `json:"sigVerify"`
				Replace    bool   `json:"replaceRecentBlockhash"`
				Commitment string `json:"commitment"`
			}
			if len(params) != 2 {
				t.Error("simulation params")
				w.WriteHeader(400)
				return
			}
			json.Unmarshal(params[1], &opts)
			if opts.SigVerify || opts.Replace || opts.Commitment != "finalized" {
				t.Error("simulation options")
				w.WriteHeader(400)
				return
			}
			var simError any
			if mutation == "simulation-error" {
				simError = "InstructionError"
			}
			result = map[string]any{"context": map[string]any{"slot": 155}, "value": map[string]any{"err": simError, "unitsConsumed": 100000}}
		case "getBlockHeight":
			result = uint64(10)
		case "getMultipleAccounts":
			var params []json.RawMessage
			json.Unmarshal(in.Params, &params)
			if len(params) != 2 {
				t.Error("batch params")
				w.WriteHeader(400)
				return
			}
			var got []string
			json.Unmarshal(params[0], &got)
			want := []string{}
			for _, k := range addresses {
				want = append(want, k.String())
			}
			var opts struct {
				Commitment string `json:"commitment"`
				Encoding   string `json:"encoding"`
				Min        uint64 `json:"minContextSlot"`
			}
			json.Unmarshal(params[1], &opts)
			if reflect.DeepEqual(got, []string{tableKey.String()}) {
				if opts.Commitment != "finalized" || opts.Encoding != "base64" || opts.Min != 151 {
					t.Error("unbound preparation lookup")
					w.WriteHeader(400)
					return
				}
				result = &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 152}}, Value: []*rpc.Account{{Owner: solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111"), Data: rpc.DataBytesOrJSONFromBytes(tableBytes)}}}
				break
			}
			if !reflect.DeepEqual(got, want) || opts.Commitment != "finalized" || opts.Encoding != "base64" || opts.Min != 100 {
				t.Error("unbound account request")
				w.WriteHeader(400)
				return
			}
			result = f.page
		default:
			t.Errorf("unexpected RPC %s", in.Method)
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": in.ID, "result": result})
	}))
	t.Cleanup(rpcServer.Close)
	// Admission to the wallet network also uses the real HTTP decoder.
	keys.genesisHash = signerRPCGenesisHashV2
	if _, err = keys.PutNetworkV2("buyer", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: rpcServer.URL}); err != nil {
		t.Fatal(err)
	}
	return &signerServiceV2{store: store, keys: keys}, signerConfig{chains: []string{"solana"}, stateDBPath: state, readOnly: true}, review, calls
}

func TestWENBTCJoinedService(t *testing.T) {
	service, cfg, review, calls := wenJoinedServiceFixture(t)
	raw, _ := json.Marshal(review.Intent)
	req := request{Op: "v2.wenBtc.inspect", WalletID: "buyer", Request: raw}
	before := calls.Load()
	server, client := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handleConn(server, cfg, newRateLimiter(time.Minute, map[string]int{req.Op: 1}), &auditWriter{path: filepath.Join(filepath.Dir(cfg.stateDBPath), "audit.jsonl"), maxBytes: 1048576}, service, false)
	}()
	client.SetDeadline(time.Now().Add(10 * time.Second))
	encoded, _ := json.Marshal(req)
	if _, err := client.Write(append(encoded, '\n')); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(client).ReadBytes('\n')
	client.Close()
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		OK     bool                     `json:"ok"`
		Error  string                   `json:"error"`
		Result signerWENBTCInspectionV1 `json:"result"`
	}
	if err = json.Unmarshal(line, &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.Result.SigningEnabled || response.Result.Status != "requires-transaction-verification" || response.Result.Readback.Slot != 150 || response.Result.OfferSHA256 != review.Pins.OfferSHA256 {
		t.Fatalf("joined inspection failed: %s", line)
	}
	if calls.Load()-before < 4 {
		t.Fatal("service did not use configured HTTP RPC")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("service transport did not finish")
	}
}

// Opt-in host for the TypeScript client integration test. This lives only in the
// test binary and cannot expose a production signer or use owner state.
func TestWENBTCJoinedClientHost(t *testing.T) {
	dir := os.Getenv("WEN_JOINED_CLIENT_TEST_DIR")
	if dir == "" {
		t.Skip("invoked by the client integration test")
	}
	operation := os.Getenv("WEN_JOINED_CLIENT_OPERATION")
	if operation == "" {
		operation = "acceptance"
	}
	mutation := os.Getenv("WEN_JOINED_CLIENT_MUTATION")
	if operation != "acceptance" && operation != "acquisition" {
		t.Fatal("invalid test operation")
	}
	service, cfg, review, calls := wenJoinedServiceCase(t, operation, mutation)
	socket := filepath.Join(dir, "signer.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err = os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	info, _ := json.Marshal(map[string]any{"socket": socket, "walletId": "buyer", "intent": review.Intent})
	if err = os.WriteFile(filepath.Join(dir, "ready.tmp"), info, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(dir, "ready.tmp"), filepath.Join(dir, "ready.json")); err != nil {
		t.Fatal(err)
	}
	listener.SetDeadline(time.Now().Add(20 * time.Second))
	conn, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	handleConn(conn, cfg, newRateLimiter(time.Minute, map[string]int{"v2.wenBtc.inspect": 1, "v2.wenBtc.prepare": 1}), &auditWriter{path: filepath.Join(filepath.Dir(cfg.stateDBPath), "audit.jsonl"), maxBytes: 1048576}, service, false)
	if mutation == "" && calls.Load()-before < 4 {
		t.Fatal("joined client did not reach chain readback")
	}
	if mutation == "route-tampered" && calls.Load() != before {
		t.Fatal("unreviewed route contacted RPC")
	}
	if (mutation == "consumed" || mutation == "underfunded") && calls.Load()-before < 2 {
		t.Fatal("test did not reach funded-account verification")
	}
}
