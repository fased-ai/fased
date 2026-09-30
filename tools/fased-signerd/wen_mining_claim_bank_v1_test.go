package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestWENMiningClaimCompiledBank(t *testing.T) {
	if os.Getenv("WEN_CLAIM_BANK_EXECUTE") != "1" {
		t.Skip("requires explicit ephemeral local compiled bank")
	}
	var input struct {
		Endpoint, Owner, Code, Descriptor, Authority string
		Seed                                         []byte
		Lost                                         bool
		Intent                                       signerWENMiningClaimIntentV1
	}
	if e := json.NewDecoder(os.Stdin).Decode(&input); e != nil {
		t.Fatal(e)
	}
	u, e := url.Parse(input.Endpoint)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("loopback bank required")
	}
	if len(input.Seed) != 32 {
		t.Fatal("ephemeral seed required")
	}
	key := solana.PrivateKey(ed25519.NewKeyFromSeed(input.Seed))
	zeroBytes(input.Seed)
	input.Seed = nil
	defer zeroBytes(key)
	if key.PublicKey().String() != input.Owner {
		t.Fatal("ephemeral owner mismatch")
	}
	v := input.Intent
	if e = validateWENMiningClaimIntentV1(v); e != nil {
		t.Fatal(e)
	}
	store, keys := openTestSignerV2(t)
	store.now = time.Now
	policy := signerPolicyV2{WalletID: "bank_test", Role: "agent", Operations: []string{intentWENMiningClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}
	_, policy, e = keys.storeNewKeyWithPolicy("bank_test", key, policy, 0)
	if e != nil {
		t.Fatal(e)
	}
	zeroBytes(key)
	for _, scope := range []string{wenMiningNativeScopeV1("bank_test", v.Genesis), wenMiningClaimLaunchScopeV1("bank_test", v)} {
		if e = store.configureWENBudgetV1(scope, 10000); e != nil {
			t.Fatal(e)
		}
	}
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, CodeSHA256: input.Code, DeploymentSlot: 1, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256}
	if input.Authority != "" {
		a, e := solana.PublicKeyFromBase58(input.Authority)
		if e != nil {
			t.Fatal(e)
		}
		pins.UpgradeAuthority = &a
	}
	observed, e := readWENMiningClaimRPCV1(context.Background(), rpc.New(input.Endpoint), pins, v, solana.MustPublicKeyFromBase58(input.Owner), 32)
	if e != nil {
		t.Fatal("compiled initial read", e)
	}
	v.AccountStateSHA256 = observed.StateHash
	descriptor, e := base64.StdEncoding.DecodeString(input.Descriptor)
	if e != nil {
		t.Fatal(e)
	}
	client := &fundingLostBank{Client: rpc.New(input.Endpoint), lost: input.Lost}
	service := &signerServiceV2{store: store, keys: keys}
	keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
	configuredEndpoint := input.Endpoint
	if _, e = keys.PutNetworkV2("bank_test", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: configuredEndpoint}); e != nil {
		t.Fatal(e)
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	claimIx, err := buildWENMiningClaimInstructionV1(v, solana.MustPublicKeyFromBase58(input.Owner))
	if err != nil {
		t.Fatal(err)
	}
	a := claimIx.Accounts()
	minBound, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expiryBound, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	page, err := client.GetMultipleAccountsWithOpts(context.Background(), []solana.PublicKey{a[5].PublicKey}, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &minBound})
	if err != nil || page == nil || len(page.Value) != 1 || page.Value[0] == nil {
		t.Fatal("bank entry", err)
	}
	d := page.Value[0].Data.GetBinary()
	if len(d) != 272 {
		t.Fatal("bank entry length")
	}
	miningRaw, miningPins := miningDescriptorFixture(t, wenMiningPinsV1{ProgramID: pins.ProgramID, Genesis: pins.Genesis, CodeSHA256: pins.CodeSHA256, DeploymentSlot: pins.DeploymentSlot, UpgradeAuthority: pins.UpgradeAuthority})
	var capital solana.PublicKey
	copy(capital[:], d[144:176])
	// Reconstruct a protected admission locator from this bank's settled entry.
	// This tests missing-journal recovery, not original commit admission execution.
	mining := signerWENMiningIntentV1{Operation: "commit", DescriptorSHA256: miningPins.DescriptorSHA256, CapabilitySHA256: miningPins.CapabilitySHA256, EntrySHA256: wenHashV1(d), CommitmentSHA256: wenHashV1([]byte("bank-admission-locator")), Genesis: v.Genesis, ProgramID: v.ProgramID, Economy: v.Economy, Offer: a[2].PublicKey.String(), Entry: a[5].PublicKey.String(), CapitalVault: capital.String(), Nonce: v.Nonce, Capital: strconv.FormatUint(binary.LittleEndian.Uint64(d[184:]), 10), Open: strconv.FormatUint(binary.LittleEndian.Uint64(d[192:]), 10), MaxFeeLamports: "5000", MinFinalizedSlot: v.MinFinalizedSlot, ExpiresSlot: v.ExpiresSlot}
	root := writeMiningReviewFixture(t, store.db.Path(), wenMiningReviewV1{Version: 1, WalletID: "bank_test", WalletPublicKey: input.Owner, Intent: mining, Pins: miningPins, MaxSlotLag: 32})
	if err := os.WriteFile(filepath.Join(root, miningPins.DescriptorSHA256), miningRaw, 0600); err != nil {
		t.Fatal(err)
	}
	batch, err := service.pollWENMiningAdmissionClaimsV1(context.Background(), cfg, "bank_test", "", 10, v.Operation, pins, descriptor, minBound, expiryBound, 5000, 32, func(selected string) signerWENBTCReadRPCV1 {
		if selected != configuredEndpoint {
			t.Fatal("poll endpoint")
		}
		return client
	})
	if err != nil || !batch.ScanComplete || batch.SigningEnabled || len(batch.Items) != 1 || batch.Items[0].ReviewDraft == nil || batch.Items[0].Status != "requires-review" || client.sends != 0 {
		t.Fatal("bank admission recovery", err)
	}
	installBody := *batch.Items[0].ReviewDraft
	if installBody.Review.Intent.ExpectedGross != v.ExpectedGross || installBody.Review.Intent.ID != v.ID || installBody.Review.Intent.Ordinal != v.Ordinal {
		t.Fatal("recovered reward mismatch")
	}
	v = installBody.Review.Intent

	if _, err := runMiningAdminBankSocketOperation(t, service, cfg, installBody, false, "install-claim-review", "v2.wenMining.claimReview.install"); err == nil {
		t.Fatal("application admitted compiled claim")
	}
	receipt, e := runMiningAdminBankSocketOperation(t, service, cfg, installBody, true, "install-claim-review", "v2.wenMining.claimReview.install")
	if e != nil || receipt.SigningEnabled || client.sends != 0 {
		t.Fatal("compiled claim review install", e)
	}
	again, e := runMiningAdminBankSocketOperation(t, service, cfg, installBody, true, "install-claim-review", "v2.wenMining.claimReview.install")
	if e != nil || again != receipt {
		t.Fatal("compiled claim review replay", e)
	}
	minimum, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	proposal, e := service.proposeConfiguredWENMiningClaimV1(context.Background(), cfg, "bank_test", v, receipt.ReviewSHA256, minimum, expires, func(string) signerWENBTCReadRPCV1 { return client })
	if e != nil || proposal.SigningEnabled || !equalWENMiningClaimIntentV1(proposal.Intent, v) || client.sends != 0 {
		t.Fatal("compiled read-only claim proposal", e)
	}
	factory := func(selected string) wenMiningClaimExecutionRPCV1 {
		if selected != configuredEndpoint {
			t.Fatal("wrong configured endpoint")
		}
		return client
	}
	authService, e := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
	if e != nil {
		t.Fatal(e)
	}
	service.webauthn = authService
	authenticator := newTestWebAuthnAuthenticatorV2(t)
	fixture := &testSignerWebAuthnFixtureV2{store: store, service: authService, walletID: "bank_test"}
	fixture.enroll(t, authenticator)
	if os.Getenv("WEN_FUNDED_BROWSER") == "1" {
		runWENFundedBrowserV1(t, service, cfg, configuredEndpoint, pins, v, descriptor, receipt.ReviewSHA256, authenticator)
		return
	}
	storedReview, e := service.prepareConfiguredWENMiningClaimReviewV1(context.Background(), cfg, "bank_test", wenMiningClaimReviewPrepareRequestV1{RequestID: "state-request", Intent: v, ReviewSHA256: receipt.ReviewSHA256}, factory)
	if e != nil {
		t.Fatal("compiled claim approval preparation", e)
	}
	begin, e := authService.beginReviewAuthorization("bank_test", signerReviewAuthorizationBeginRequestV2{RequestID: storedReview.RequestID})
	if e != nil {
		t.Fatal("compiled claim approval begin", e)
	}
	finish, e := fixture.finishReview(t, begin, authenticator, 2)
	if e != nil {
		t.Fatal("compiled claim approval finish", e)
	}
	body, _ := json.Marshal(wenMiningClaimJourneyRequestV1{RequestID: storedReview.RequestID, Action: "execute", Proof: &finish.Authorization.Proof})
	encoded, e := service.miningClaimJourneyWithFactoryV1(context.Background(), request{WalletID: "bank_test", Request: body}, cfg, factory)
	var envelope struct {
		Result wenMiningClaimJourneyResultV1 `json:"result"`
	}
	if e == nil {
		e = json.Unmarshal(encoded, &envelope)
	}
	digest, status := envelope.Result.Digest, envelope.Result.Outcome

	if e != nil || status != "finalized-success" || client.sends != 1 {
		t.Fatalf("compiled bank execution: status=%s sends=%d error=%v", status, client.sends, e)
	}
	saved := readWENState(t, store)
	if !saved.SuccessBudgetSettled || saved.OutcomeFee != 5000 || saved.SuccessNativeDebit != 5000 || saved.MiningClaimEffectsSHA256 == "" {
		t.Fatal("unreconciled compiled claim effects")
	}
	if root := os.Getenv("WEN_CLAIM_JOURNEY_RECEIPTS"); root != "" {
		if saved.ClaimAuthorization == nil || saved.ClaimAuthorization.ProofID != finish.Authorization.Proof.ProofID {
			t.Fatal("compiled claim missing human approval")
		}
		proof, err := json.Marshal(map[string]any{"operation": v.Operation, "outcome": status, "digest": digest, "sends": client.sends, "feeLamports": saved.OutcomeFee, "humanApproval": true, "budgetSettled": saved.SuccessBudgetSettled})
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, v.Operation+".json"), proof, 0600); err != nil {
			t.Fatal(err)
		}
	}
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
	if status, e = store.recoverWENMiningClaimExecutionV1(context.Background(), client, "state-request", digest); e != nil || status != "finalized-success" {
		t.Fatal("keyless bank recovery", status, e)
	}
	if _, e = store.prepareWENMiningClaimSubmissionV1(context.Background(), client, "state-request", digest); e == nil {
		t.Fatal("replayed compiled claim")
	}
	if client.sends != 1 {
		t.Fatal("recovery resent")
	}
	t.Logf("PASS: admission discovery/poll, CLI/control-socket review and configured compiled bank, %s claim, 5000 fee, no rent, lostReply=%t; keyless reopened recovery, no resend", v.Operation, input.Lost)
}
