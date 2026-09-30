package main

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Only the compiled local-bank harness supplies this disposable key and reviewed
// fixture identity. This does not admit a public deployment or enable Auto.
func TestWENMiningCompiledBank(t *testing.T) {
	if os.Getenv("WEN_MINING_BANK_EXECUTE") != "1" {
		t.Skip("requires explicit ephemeral compiled bank")
	}
	var input struct {
		Endpoint, Program, Owner, Authority, Economy, Offer, Vault, Entry, Nonce, Capital, Open, Operation, SBF, Digest, StateDir string
		Seed, EntryData                                                                                                           []byte
	}
	if e := json.NewDecoder(os.Stdin).Decode(&input); e != nil {
		t.Fatal(e)
	}
	u, e := url.Parse(input.Endpoint)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("loopback required")
	}
	if !filepath.IsAbs(input.StateDir) || !strings.HasPrefix(filepath.Base(input.StateDir), "wen-mining-bank-") {
		t.Fatal("explicit disposable mining state required")
	}
	info, e := os.Lstat(input.StateDir)
	if e != nil || !info.IsDir() || info.Mode().Perm() != 0700 || info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("protected fixture directory required")
	}
	if input.Operation != "commit" && input.Operation != "reveal" {
		t.Fatal("invalid phase")
	}
	if input.Operation == "reveal" && len(input.Seed) != 0 {
		t.Fatal("reveal must reuse persisted key, not reimport seed")
	}
	client := &fundingLostBank{Client: rpc.New(input.Endpoint), lost: true}
	ctx := context.Background()
	slot, e := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		t.Fatal(e)
	}
	genesis, e := client.GetGenesisHash(ctx)
	if e != nil {
		t.Fatal(e)
	}
	code, e := os.ReadFile(input.SBF)
	if e != nil {
		t.Fatal(e)
	}
	// Synthetic release acknowledgement with real portable interface semantics.
	authority, e := solana.PublicKeyFromBase58(input.Authority)
	if e != nil {
		t.Fatal(e)
	}
	descriptorRaw, pins := miningDescriptorFixture(t, wenMiningPinsV1{ProgramID: input.Program, Genesis: genesis.String(), CodeSHA256: wenHashV1(code), DeploymentSlot: 1, UpgradeAuthority: &authority})
	descriptor, capability := pins.DescriptorSHA256, pins.CapabilitySHA256
	v := signerWENMiningIntentV1{Operation: input.Operation, DescriptorSHA256: descriptor, CapabilitySHA256: capability, EntrySHA256: wenHashV1(input.EntryData), CommitmentSHA256: input.Digest, Genesis: genesis.String(), ProgramID: input.Program, Economy: input.Economy, Offer: input.Offer, CapitalVault: input.Vault, Entry: input.Entry, Nonce: input.Nonce, Capital: input.Capital, Open: input.Open, MaxFeeLamports: "5000", MinFinalizedSlot: strconv.FormatUint(slot, 10), ExpiresSlot: strconv.FormatUint(slot+32, 10)}
	if e = validateWENMiningIntentV1(v); e != nil {
		t.Fatal(e)
	}
	dbPath := filepath.Join(input.StateDir, "state.db")
	if _, e = os.Stat(dbPath); input.Operation == "commit" && !errors.Is(e, os.ErrNotExist) || input.Operation == "reveal" && e != nil {
		t.Fatal("unexpected persistent state phase")
	}
	store, e := openSignerStoreV2(dbPath)
	if e != nil {
		t.Fatal(e)
	}
	defer func() { _ = store.Close() }()
	store.now = time.Now
	keys, e := openSignerKeyManagerV2(store, filepath.Join(input.StateDir, "master.key"))
	if e != nil {
		t.Fatal(e)
	}
	defer keys.Close()
	var policy signerPolicyV2
	if input.Operation == "commit" {
		if len(input.Seed) != 32 {
			t.Fatal("ephemeral seed required")
		}
		key := solana.PrivateKey(ed25519.NewKeyFromSeed(input.Seed))
		zeroBytes(input.Seed)
		input.Seed = nil
		defer zeroBytes(key)
		if key.PublicKey().String() != input.Owner {
			t.Fatal("owner mismatch")
		}
		policy = signerPolicyV2{WalletID: "bank_test", Role: "agent", Operations: []string{intentWENMiningV1 + ".commit", intentWENMiningV1 + ".reveal"}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}
		_, policy, e = keys.storeNewKeyWithPolicy("bank_test", key, policy, 0)
		if e != nil {
			t.Fatal(e)
		}
		zeroBytes(key)
		for _, scope := range []string{wenMiningNativeScopeV1("bank_test", v.Genesis), wenMiningLaunchScopeV1("bank_test", v)} {
			if e = store.configureWENBudgetV1(scope, 10000); e != nil {
				t.Fatal(e)
			}
		}
	} else {
		policy, e = store.getPolicy("bank_test")
		if e != nil {
			t.Fatal(e)
		}
		prior := readMiningBankState(t, store, "commit")
		if prior.MiningIntent == nil || prior.MiningIntent.CommitmentSHA256 != v.CommitmentSHA256 || prior.MiningIntent.Entry != v.Entry {
			t.Fatal("prior commitment identity")
		}
		if status, e := store.recoverWENMiningExecutionV1(ctx, client, "mining-commit", prior.Digest); e != nil || status != "finalized-success" || client.sends != 0 {
			t.Fatal("prior commit keyless recovery", status, e)
		}
	}
	endpoint := input.Endpoint
	keys.genesisHash = signerRPCGenesisHashV2
	networkVersion := uint64(0)
	if v.Operation == "reveal" {
		networkVersion = 1
	}
	if _, e = keys.PutNetworkV2("bank_test", signerNetworkPutRequestV2{ExpectedVersion: &networkVersion, PrimaryRPCURL: endpoint}); e != nil {
		t.Fatal(e)
	}

	if v.Operation == "reveal" {
		keys.genesisHash = signerRPCGenesisHashV2
		handoffService := &signerServiceV2{store: store, keys: keys}
		proposal, _, handoffStatus, e := handoffService.continueMiningRevealWithFactoryV1(ctx, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, "mining-commit", "mining-reveal", "bank_test", slot, slot+32, time.Second, 2, func(string) wenMiningExecutionRPCV1 { return client })
		if handoffStatus != "requires-review" || client.sends != 0 {
			t.Fatal("handoff did not wait for review", handoffStatus, e)
		}
		if e != nil || proposal != v {
			t.Fatal("proposal differs from compiled bank committed entry", e)
		}
		if _, _, e = loadWENMiningReviewV1(store.db.Path(), "bank_test", proposal); e == nil {
			t.Fatal("proposal implicitly admitted")
		}
		v = proposal
		t.Log("PASS: reveal proposal from settled commit matches compiled entry; separate exact review still required")
	}

	review := wenMiningReviewV1{Version: 2, WalletID: "bank_test", WalletPublicKey: input.Owner, Intent: v, Pins: pins, MaxSlotLag: 32}
	root := filepath.Join(filepath.Dir(store.db.Path()), "wen-mining", wenHashV1([]byte("bank_test")))
	if e = os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	if v.Operation == "commit" {
		// Protected secret preparation remains a separate prerequisite.
	} else {
		prior := readMiningBankState(t, store, "commit")
		base, _, e := loadWENMiningReviewV1(store.db.Path(), "bank_test", *prior.MiningIntent)
		if e != nil {
			t.Fatal(e)
		}
		body := wenMiningReviewInstallV1{CommitRequest: "mining-commit", BaseReviewSHA256: base.reviewSHA, Intent: v}
		service := &signerServiceV2{store: store, keys: keys}
		cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}

		for _, mode := range []string{"stale-base", "changed-intent", "readonly", "wrong-wallet", "conflict"} {
			badBody := body
			badCfg := cfg
			id := "bank_test"
			switch mode {
			case "stale-base":
				badBody.BaseReviewSHA256 = wenHashV1([]byte("old"))
			case "changed-intent":
				badBody.Intent.Capital = "1"
			case "readonly":
				badCfg.readOnly = true
			case "wrong-wallet":
				id = "other"
			case "conflict":
				if e = os.WriteFile(filepath.Join(root, wenMiningAdmissionNameV2(v)), []byte("{}"), 0600); e != nil {
					t.Fatal(e)
				}
			}
			if _, e := service.installMiningRevealReviewV1(ctx, badCfg, id, badBody, true, func(string) wenMiningExecutionRPCV1 { return client }); e == nil {
				t.Fatal("invalid review install", mode)
			}
			if mode == "conflict" {
				after, e := os.ReadFile(filepath.Join(root, wenMiningAdmissionNameV2(v)))
				if e != nil || string(after) != "{}" {
					t.Fatal("overwrote conflicting review")
				}
				if e = os.Remove(filepath.Join(root, wenMiningAdmissionNameV2(v))); e != nil {
					t.Fatal(e)
				}
			}
		}

		for _, control := range []bool{false, true, true} {
			receipt, e := runMiningAdminBankSocket(t, service, cfg, body, control)
			if !control {
				if e == nil {
					t.Fatal("application installed review")
				}
				continue
			}
			if e != nil || receipt.Status != "review-installed" || receipt.SigningEnabled {
				t.Fatal("CLI owner review", e)
			}
		}

		t.Log("PASS: owner-only reveal review installed and idempotently read back; application denied; no signature")
	}
	preimagePath := filepath.Join(root, wenMiningPreimageKeyV1(v, solana.MustPublicKeyFromBase58(input.Owner))+".json")
	if input.Operation == "commit" {
		salt := make([]byte, 32)
		for i := range salt {
			salt[i] = 29
		}
		preimage := wenMiningPreimageV1{Schema: "wen.mining-preimage.v1", Scope: wenMiningPreimageScopeV1{v.Genesis, v.ProgramID, v.Economy, v.Offer, input.Owner, v.CapitalVault, v.Nonce, v.Capital, v.Open}, Allocation: []uint16{4000, 3000, 2000, 1000}, Salt: hex.EncodeToString(salt), Digest: v.CommitmentSHA256}
		preimageBody := wenMiningPreimageInstallV1{Intent: v, Preimage: preimage}
		for _, control := range []bool{false, true, true} {
			receipt, err := runMiningPreimageBankSocket(t, &signerServiceV2{store: store, keys: keys}, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, preimageBody, control, "install-preimage", "v2.wenMining.preimage.install")
			if !control {
				if err == nil {
					t.Fatal("application secret import accepted")
				}
				continue
			}
			if err != nil || receipt.CommitmentSHA256 != v.CommitmentSHA256 {
				t.Fatal("protected secret import", err)
			}
		}
		t.Log("PASS: owner preimage CLI persists exact secret; application denied; identical retry preserved before bootstrap")
		service := &signerServiceV2{store: store, keys: keys}
		cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
		body := wenMiningBootstrapV1{Review: review, Descriptor: descriptorRaw}
		for _, control := range []bool{false, true, true} {
			receipt, err := runMiningAdminBankSocketOperation(t, service, cfg, body, control, "install-commit-review", "v2.wenMining.bootstrap.install")
			if !control {
				if err == nil {
					t.Fatal("application bootstrap accepted")
				}
				continue
			}
			if err != nil || receipt.Status != "review-installed" {
				t.Fatal("bootstrap", err)
			}
		}
		conflict := body
		conflict.Review.MaxSlotLag++
		if _, err := service.installMiningBootstrapV1(ctx, cfg, "bank_test", conflict, true, func(string) wenMiningExecutionRPCV1 { return client }); err == nil {
			t.Fatal("bootstrap overwrote review")
		}
		installed, _, err := loadWENMiningAdmissionV1(store.db.Path(), "bank_test", v)
		expected, _ := json.Marshal(review)
		if err != nil || installed.reviewSHA != wenHashV1(expected) {
			t.Fatal("bootstrap changed rights", err)
		}
		t.Log("PASS: owner bootstrap CLI installs exact descriptor/commit review; application denied; retry and conflict preserve rights")
	} else {
		// A missing or changed persisted secret must reject preparation. Restore
		// the exact bytes only for this controlled negative test, never regenerate.
		original, e := os.ReadFile(preimagePath)
		if e != nil {
			t.Fatal(e)
		}
		defer zeroBytes(original)
		if e = os.Rename(preimagePath, preimagePath+".saved"); e != nil {
			t.Fatal(e)
		}
		if _, e = prepareWENMiningFromRPCV1(ctx, client, root, pins, v, solana.MustPublicKeyFromBase58(input.Owner), 32); e == nil {
			t.Fatal("missing preimage accepted")
		}
		if e = os.WriteFile(preimagePath, []byte("{}"), 0600); e != nil {
			t.Fatal(e)
		}
		if _, e = prepareWENMiningFromRPCV1(ctx, client, root, pins, v, solana.MustPublicKeyFromBase58(input.Owner), 32); e == nil {
			t.Fatal("corrupt preimage accepted")
		}
		if e = os.Rename(preimagePath+".saved", preimagePath); e != nil {
			t.Fatal(e)
		}
		restored, e := os.ReadFile(preimagePath)
		if e != nil || string(restored) != string(original) {
			t.Fatal("secret changed across restart")
		}
		zeroBytes(restored)
		if client.sends != 0 {
			t.Fatal("negative preparation submitted")
		}
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	service := &signerServiceV2{store: store, keys: keys}

	factory := func(selected string) wenMiningExecutionRPCV1 {
		if selected != endpoint {
			t.Fatal("changed configured endpoint")
		}
		return client
	}
	var digest, status string
	if v.Operation == "reveal" {
		var proposed signerWENMiningIntentV1
		proposed, digest, status, e = service.continueMiningRevealWithFactoryV1(ctx, cfg, "mining-commit", "mining-reveal", "bank_test", slot, slot+32, time.Second, 2, factory)
		if proposed != v {
			t.Fatal("handoff changed reviewed reveal")
		}
	} else {
		digest, status, e = service.runConfiguredMiningWithFactoryV1(ctx, cfg, "mining-commit", "bank_test", v, time.Second, 2, factory)
	}

	if e != nil || status != "finalized-success" || client.sends != 1 {
		t.Fatalf("compiled %s status=%s sends=%d error=%v", v.Operation, status, client.sends, e)
	}
	t.Log("PASS: bounded configured mining runner completed reviewed operation")
	saved := readMiningBankState(t, store, v.Operation)
	if !saved.SuccessBudgetSettled || saved.OutcomeFee != 5000 || saved.SuccessNativeDebit != 5000 {
		t.Fatal("fee reconciliation")
	}
	discovered, e := service.discoverConfiguredWENMiningClaimsV1(ctx, cfg, "bank_test", "", 100)
	if e != nil || discovered.SigningEnabled || len(discovered.Candidates) != 1 || discovered.Candidates[0].CommitRequest != "mining-commit" || discovered.Candidates[0].Intent.Entry != v.Entry || client.sends != 1 {
		t.Fatal("compiled journal candidate discovery", e)
	}
	t.Log("PASS: configured journal discovery identifies committed entry without a claim review, RPC or send; settlement readback remains required")
	keys.Close()
	path := store.db.Path()
	if e = store.Close(); e != nil {
		t.Fatal(e)
	}
	store, e = openSignerStoreV2(path)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	after, e := store.discoverWENMiningClaimsV1(ctx, "bank_test", saved.WalletPublicKey, "", 100)
	if e != nil || len(after.Candidates) != 1 || after.Candidates[0] != discovered.Candidates[0] {
		t.Fatal("keyless discovery restart", e)
	}
	if status, e = store.recoverWENMiningExecutionV1(ctx, client, "mining-"+v.Operation, digest); e != nil || status != "finalized-success" {
		t.Fatal("keyless recovery", status, e)
	}
	if client.sends != 1 {
		t.Fatal("recovery resent")
	}
	recoveryKeys, e := openSignerKeyManagerV2(store, filepath.Join(input.StateDir, "master.key"))
	if e != nil {
		t.Fatal(e)
	}
	defer recoveryKeys.Close()
	recoveryKeys.genesisHash = signerRPCGenesisHashV2
	recoveryService := &signerServiceV2{store: store, keys: recoveryKeys}
	if e = os.Remove(filepath.Join(root, descriptor)); e != nil {
		t.Fatal(e)
	}
	recoveredDigest, recoveredStatus, e := recoveryService.stepConfiguredMiningWithFactoryV1(ctx, cfg, "restart-alias-request", "bank_test", v, func(selected string) wenMiningExecutionRPCV1 {
		if selected != endpoint {
			t.Fatal("recovery endpoint")
		}
		return client
	})
	if e != nil || recoveredDigest != digest || recoveredStatus != "finalized-success" || client.sends != 1 {
		t.Fatal("compiled recovery-first step", recoveredStatus, e)
	}
	t.Log("PASS: recovery-first step uses indexed action after configuration-key reopen; new request ID causes no resend")
	if e = os.WriteFile(filepath.Join(root, descriptor), descriptorRaw, 0600); e != nil {
		t.Fatal(e)
	}
	t.Log("PASS: compiled journal recovery succeeds without descriptor; no new signing or send")

	if v.Operation == "reveal" {
		prior := readMiningBankState(t, store, "commit")
		if e = os.Remove(filepath.Join(root, wenMiningAdmissionNameV2(v))); e != nil {
			t.Fatal(e)
		}
		resumed, recoveredDigest, recoveredStatus, e := recoveryService.continueMiningRevealWithFactoryV1(ctx, cfg, "mining-commit", "different-reveal-id", "bank_test", 0, 0, time.Second, 2, factory)
		if e != nil || resumed != v || recoveredDigest != digest || recoveredStatus != "finalized-success" || client.sends != 1 {
			t.Fatal("handoff recovery after removed review", recoveredStatus, e)
		}
		t.Log("PASS: host handoff waits for exact review, executes reveal, then recovers indexed reveal after restart without review or resend")

		if prior.SuccessNativeDebit+saved.SuccessNativeDebit != 10000 || !prior.SuccessBudgetSettled {
			t.Fatal("combined fee conservation")
		}
		if status, e = store.recoverWENMiningExecutionV1(ctx, client, "mining-commit", prior.Digest); e != nil || status != "finalized-success" {
			t.Fatal("commit recovery after reveal", status, e)
		}
		if client.sends != 1 {
			t.Fatal("post-reveal recovery resent")
		}
		if e = store.db.View(func(tx *bolt.Tx) error {
			for scope := range saved.Scopes {
				var balance wenBudgetBalanceV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
					return e
				}
				if balance.Limit != 10000 || balance.Reserved != 10000 {
					return errors.New("persisted fee budget not fully accounted")
				}
			}
			if string(tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(saved.WalletID, "solana:native", saved.UsageDay))) != "10000" {
				return errors.New("daily fees did not survive restart")
			}
			return nil
		}); e != nil {
			t.Fatal(e)
		}
		t.Log("PASS: same persisted signer key, preimage, policy and budgets across process restart; missing/corrupt preimage rejected; combined fees 10000")
	}
	t.Logf("PASS: compiled Fased mining %s; 5000 fee, lost reply, keyless recovery, one send", v.Operation)
}

func readMiningBankState(t *testing.T, s *signerStoreV2, request string) wenBudgetReservationV1 {
	t.Helper()
	var value wenBudgetReservationV1
	if e := s.db.View(func(tx *bolt.Tx) error {
		return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:mining-"+request)), &value)
	}); e != nil {
		t.Fatal(e)
	}
	return value
}
