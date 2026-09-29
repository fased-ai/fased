package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Disposable host for the real TypeScript caller. Empty/rejected admission
// scans require no fake network read and never contact a public RPC.
func TestWENMiningRecoverySocketHost(t *testing.T) {
	dir := os.Getenv("WEN_RECOVERY_SOCKET_DIR")
	if dir == "" {
		t.Skip("client-driven local socket test")
	}
	mode := os.Getenv("WEN_RECOVERY_SOCKET_MODE")
	op := "sol"
	if strings.Contains(mode, "sat") {
		op = "sat"
	}
	_, _, pins, _ := miningClaimRPCFixture(t, op)
	raw, pins := miningClaimReviewDescriptor(t, pins)
	store, keys, v, _, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
	root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining", wenHashV1([]byte("miner")))
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("WEN_RECOVERY_SOCKET_MODE") == "malformed" {
		if err := os.WriteFile(filepath.Join(root, "admission.json"), []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	endpoint := "https://must-not-be-contacted.invalid"
	if strings.HasPrefix(mode, "funded") {
		f := client.miningClaimRPCFake
		owner := client.expectedOwner
		program := solana.MustPublicKeyFromBase58(v.ProgramID)
		sale := solana.MustPublicKeyFromBase58(v.Economy)
		if op == "sat" {
			mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), sale[:]}, program)
			dest, _, _ := solana.FindProgramAddress([][]byte{owner[:], solana.Token2022ProgramID[:], mint[:]}, solana.SPLAssociatedTokenAccountProgramID)
			f.addresses[13] = dest
		}
		data := append([]byte(nil), f.page.Value[1].Data.GetBinary()...)
		number := func(n uint64) string { return strconv.FormatUint(n, 10) }
		var capital solana.PublicKey
		copy(capital[:], data[144:176])
		open := binary.LittleEndian.Uint64(data[192:])
		mining := signerWENMiningIntentV1{Operation: "commit", DescriptorSHA256: pins.DescriptorSHA256, CapabilitySHA256: pins.CapabilitySHA256, EntrySHA256: wenHashV1(data), CommitmentSHA256: wenHashV1([]byte("uncommitted")), Genesis: v.Genesis, ProgramID: v.ProgramID, Economy: v.Economy, Offer: f.addresses[0].String(), Entry: f.addresses[1].String(), CapitalVault: capital.String(), Nonce: v.Nonce, Capital: number(binary.LittleEndian.Uint64(data[184:])), Open: number(open), MaxFeeLamports: "5000", MinFinalizedSlot: "100", ExpiresSlot: "132"}
		entry := wenMiningEntrySnapshotV1{Address: f.addresses[1], Owner: program, Data: data, Slot: 101, Now: open}
		if _, e := prepareWENMiningInstructionV1(mining, owner, entry, nil); e != nil {
			t.Fatal("accepted fixture", e)
		}
		miningRaw, miningPins := miningDescriptorFixture(t, wenMiningPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, CodeSHA256: pins.CodeSHA256, DeploymentSlot: pins.DeploymentSlot, UpgradeAuthority: pins.UpgradeAuthority})
		mining.DescriptorSHA256 = miningPins.DescriptorSHA256
		mining.CapabilitySHA256 = miningPins.CapabilitySHA256
		review := wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: owner.String(), Intent: mining, Pins: miningPins, MaxSlotLag: 2}
		root = writeMiningReviewFixture(t, store.db.Path(), review)
		if strings.HasSuffix(mode, "pages") {
			review.Version = 2
			encoded, err := json.Marshal(review)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, wenMiningAdmissionNameV2(mining)), encoded, 0600); err != nil {
				t.Fatal(err)
			}
		}

		if err := os.WriteFile(filepath.Join(root, miningPins.DescriptorSHA256), miningRaw, 0600); err != nil {
			t.Fatal(err)
		}
		locator := &miningClaimLocatorFake{miningClaimRPCFake: f}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer r.Body.Close()
			var in struct {
				ID     json.RawMessage
				Method string
				Params []json.RawMessage
			}
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			var result any
			switch in.Method {
			case "getGenesisHash":
				result = v.Genesis
			case "getSlot":
				result = f.reference
			case "getMultipleAccounts":
				if strings.Contains(mode, "replace") {
					if err := os.WriteFile(filepath.Join(dir, "reading"), []byte("ready"), 0600); err != nil {
						t.Error(err)
						return
					}
					deadline := time.Now().Add(5 * time.Second)
					for {
						if _, err := os.Stat(filepath.Join(dir, "resume")); err == nil {
							break
						}
						if time.Now().After(deadline) {
							t.Error("profile replacement timeout")
							return
						}
						time.Sleep(10 * time.Millisecond)
					}
				}
				if len(in.Params) != 2 {
					t.Error("account params")
					return
				}
				var addresses []solana.PublicKey
				var opts rpc.GetMultipleAccountsOpts
				if err := json.Unmarshal(in.Params[0], &addresses); err != nil {
					t.Error(err)
					return
				}
				if err := json.Unmarshal(in.Params[1], &opts); err != nil {
					t.Error(err)
					return
				}
				var err error
				result, err = locator.GetMultipleAccountsWithOpts(r.Context(), addresses, &opts)
				if err != nil {
					t.Error(err)
					return
				}
			default:
				t.Errorf("unexpected RPC method: %s", in.Method)
				w.WriteHeader(400)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": in.ID, "result": result}); err != nil {
				t.Error(err)
			}
		}))
		defer server.Close()
		endpoint = server.URL
	}

	keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
	if _, err := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "signer.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	body := wenMiningClaimRecoveryRequestV1{Limit: 1, Operation: op, Pins: pins, Descriptor: raw, MinFinalizedSlot: "100", ExpiresSlot: "132", MaxFeeLamports: "5000", MaxSlotLag: "2"}
	ready, _ := json.Marshal(map[string]any{"socket": socket, "walletId": "miner", "request": body})
	if err := os.WriteFile(filepath.Join(dir, "ready.tmp"), ready, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "ready.tmp"), filepath.Join(dir, "ready.json")); err != nil {
		t.Fatal(err)
	}
	requests := 1
	if strings.HasSuffix(mode, "restart") || strings.HasSuffix(mode, "pages") || strings.HasSuffix(mode, "consumer") {
		requests = 2
	}
	for i := 0; i < requests; i++ {
		listener.SetDeadline(time.Now().Add(15 * time.Second))
		conn, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		handleConn(conn, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}, readOnly: true}, newRateLimiter(time.Minute, map[string]int{"v2.wenMining.claim.recover": 1}), &auditWriter{}, &signerServiceV2{store: store, keys: keys}, false)
	}
	if strings.HasSuffix(mode, "admit") {
		var exported []byte
		deadline := time.Now().Add(10 * time.Second)
		for {
			exported, err = os.ReadFile(filepath.Join(dir, "exported.json"))
			if err == nil {
				break
			}
			if !os.IsNotExist(err) || time.Now().After(deadline) {
				t.Fatal("export missing", err)
			}
			time.Sleep(10 * time.Millisecond)
		}
		var draft wenMiningClaimBootstrapV1
		if err := decodeSignerAdminStrictJSON(exported, &draft); err != nil {
			t.Fatal(err)
		}
		controlPath := filepath.Join(dir, "control.sock")
		controlListener, err := net.ListenUnix("unix", &net.UnixAddr{Name: controlPath, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		defer controlListener.Close()
		if err := os.Chmod(controlPath, 0600); err != nil {
			t.Fatal(err)
		}
		var previous []byte
		for _, control := range []bool{false, true, true} {
			finished := make(chan error, 1)
			go func(control bool) {
				controlListener.SetDeadline(time.Now().Add(10 * time.Second))
				conn, err := controlListener.Accept()
				if err != nil {
					finished <- err
					return
				}
				handleConn(conn, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, newRateLimiter(time.Minute, map[string]int{"v2.wenMining.claimReview.install": 1}), &auditWriter{path: filepath.Join(dir, "audit.jsonl"), maxBytes: 1048576}, &signerServiceV2{store: store, keys: keys}, control)
				finished <- nil
			}(control)
			var stdout bytes.Buffer
			err := runSignerAdminCLI([]string{"wen-mining", "install-claim-review", "--control-socket", controlPath, "--wallet-id", "miner"}, bytes.NewReader(exported), &stdout, nil)
			if serveErr := <-finished; serveErr != nil {
				t.Fatal(serveErr)
			}
			if !control {
				if err == nil || stdout.Len() != 0 {
					t.Fatal("application admission accepted")
				}
				continue
			}
			if err != nil {
				t.Fatal("daemon admission", err)
			}
			var receipt wenMiningReviewReceiptV1
			if err := json.Unmarshal(stdout.Bytes(), &receipt); err != nil || receipt.SigningEnabled || receipt.Status != "review-installed" {
				t.Fatal("receipt", err)
			}
			if previous != nil && !bytes.Equal(previous, stdout.Bytes()) {
				t.Fatal("repeat receipt changed")
			}
			previous = append([]byte(nil), stdout.Bytes()...)
			if _, _, err := loadWENMiningClaimAdmissionV1(store.db.Path(), "miner", draft.Review.Intent); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(dir, "admitted.json"), previous, 0600); err != nil {
			t.Fatal(err)
		}
		// The real TS caller now refreshes this exact admission over the application
		// socket. All four requests are read-only, including rejected mutations.
		for i := 0; i < 4; i++ {
			listener.SetDeadline(time.Now().Add(15 * time.Second))
			conn, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			handleConn(conn, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}, readOnly: true}, newRateLimiter(time.Minute, map[string]int{"v2.wenMining.claim.propose": 1}), &auditWriter{}, &signerServiceV2{store: store, keys: keys}, false)
		}
		var admitted wenMiningReviewReceiptV1
		if err := json.Unmarshal(previous, &admitted); err != nil {
			t.Fatal(err)
		}
		current, _, err := loadWENMiningClaimAdmissionV1(store.db.Path(), "miner", draft.Review.Intent)
		if err != nil || current.reviewSHA != admitted.ReviewSHA256 {
			t.Fatal("proposal changed admission", err)
		}
	}
	if client.sends != 0 {
		t.Fatal("recovery sent")
	}
}
