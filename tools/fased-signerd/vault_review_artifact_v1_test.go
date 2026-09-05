package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"strings"
	"testing"
	"time"
)

func TestVaultReviewArtifactV1(t *testing.T) {
	scope, _ := vaultCycleReserveFixtureV1(t)
	ref := vaultReviewReferenceV1{Scope: scope, Commitment: signerSATCommitmentBindingRequestV1{Cluster: "devnet", ProgramID: satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID, ProtocolGeneration: "2", CycleID: "43"}, Reference: "sha256:" + strings.Repeat("a", 64), Blockhash: solana.Hash{1}.String(), TransactionDigest: "sha256:" + strings.Repeat("b", 64)}
	digest, err := vaultReviewReferenceDigestV1(ref, scope.Executor.String())
	if err != nil {
		t.Fatal(err)
	}
	input := signerReviewArtifactInputV2{Kind: signerReviewArtifactVaultReferenceV1, WalletPublicKey: scope.Executor.String(), Digest: digest, VaultReference: &ref, StateDigest: "sha256:" + strings.Repeat("c", 64), StateSlot: 250}
	artifact, err := normalizeReviewArtifactInputV2(input)
	if err != nil {
		t.Fatal(err)
	}
	review := signerReviewV2{ArtifactKind: artifact.Kind, ArtifactDigest: artifact.Digest, WalletPublicKey: artifact.WalletPublicKey, VaultReference: artifact.VaultReference, StateDigest: artifact.StateDigest, StateSlot: artifact.StateSlot}
	review.IntentType = intentSolanaVaultMining
	raw, err := json.Marshal(review)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"serializedTxBase64", "allocationFP", "nonceBase64", "dataBase64"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("review exposes %s", forbidden)
		}
	}
	var restored signerReviewV2
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeStoredReviewArtifactV2(restored); err != nil {
		t.Fatal(err)
	}
	ref.Blockhash = solana.Hash{2}.String()
	if artifact.VaultReference.Blockhash == ref.Blockhash {
		t.Fatal("artifact retained mutable input pointer")
	}
	if _, err := normalizeReviewArtifactInputV2(input); err == nil {
		t.Fatal("accepted changed blockhash")
	}
	for _, mutate := range []func(*signerReviewArtifactInputV2){
		func(a *signerReviewArtifactInputV2) { a.Transaction = &signerSolanaTransactionEnvelopeV2{} },
		func(a *signerReviewArtifactInputV2) { a.MessageBase64 = "secret" },
		func(a *signerReviewArtifactInputV2) { a.StateSlot = 0 },
		func(a *signerReviewArtifactInputV2) { a.StateDigest = "" },
		func(a *signerReviewArtifactInputV2) { a.VaultReference = nil },
		func(a *signerReviewArtifactInputV2) { a.Kind = signerReviewArtifactSolanaTransactionV2 },
		func(a *signerReviewArtifactInputV2) { a.WalletPublicKey = scope.Keeper.String() },
	} {
		a := artifact
		mutate(&a)
		if _, err := normalizeReviewArtifactInputV2(a); err == nil {
			t.Fatal("accepted malformed Vault review")
		}
	}
	restored.VaultReference.Reference = "sha256:" + strings.Repeat("d", 64)
	if _, err := normalizeStoredReviewArtifactV2(restored); err == nil {
		t.Fatal("accepted changed persisted reference")
	}
}

func TestVaultReviewPolicyPersistenceV1(t *testing.T) {
	store, keys := openTestSignerV2(t)
	scope, _ := vaultCycleReserveFixtureV1(t)
	wallet, _, err := keys.CreateWithRoleBaseline("vault-executor", 0, signerRoleBaselineRequestV1{Version: 1, Role: "agent"}, signerRoleBaselineRuntimeV1{})
	if err != nil {
		t.Fatal(err)
	}
	scope.Executor = solana.MustPublicKeyFromBase58(wallet.PublicKey)
	input := signerIntentV2{Type: intentSolanaVaultMining, Cluster: "devnet", Action: "commit_vault_cycle", VaultMining: &signerVaultMiningIntentV1{
		Profile: scope.Profile.String(), PermanentMining: scope.PermanentMining.String(), Reference: "sha256:" + strings.Repeat("a", 64), CycleID: "43", CommittedLamports: "1000000000", AuthorityGeneration: "1", BindingGeneration: "1", ActivationGeneration: "7", MaxRentLamports: "5000000", MaxFeeLamports: "5000", MinFinalizedSlot: "101",
	}}
	intent, err := normalizeSignerIntentForWalletV2(input, &scope.Executor)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := store.putPolicy(signerPolicyV2{WalletID: "vault-executor", Role: "agent", Operations: []string{intent.PolicyOperation}, Programs: intent.RequiredPrograms, Assets: []signerPolicyAssetV2{
		{Asset: intent.Asset, Destinations: []string{intent.Destination}, MaxPerTx: "1", MaxDaily: "2"},
		{Asset: "solana:native", Destinations: []string{scope.Executor.String()}, MaxPerTx: "5005000", MaxDaily: "10010000"},
	}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	ref := vaultReviewReferenceV1{Scope: scope, Commitment: signerSATCommitmentBindingRequestV1{Cluster: "devnet", ProgramID: satcoinOwnerInstructionContractsV1["sat_init_agent_record"].ProgramID, ProtocolGeneration: "2", CycleID: "43"}, Reference: input.VaultMining.Reference, Blockhash: solana.Hash{1}.String(), TransactionDigest: "sha256:" + strings.Repeat("b", 64)}
	digest, err := vaultReviewReferenceDigestV1(ref, scope.Executor.String())
	if err != nil {
		t.Fatal(err)
	}
	artifact := signerReviewArtifactInputV2{Kind: signerReviewArtifactVaultReferenceV1, WalletPublicKey: scope.Executor.String(), Digest: digest, VaultReference: &ref, StateDigest: "sha256:" + strings.Repeat("c", 64), StateSlot: 101}
	now := time.Now().UTC()
	store.now = func() time.Time { return now }
	req := signerReviewPrepareRequestV2{RequestID: "vault-durable-review", PolicyHash: policy.Hash, Mode: jupiterReviewModeReviewedV2, Intent: input}
	first, err := store.prepareArtifactReviewV2("vault-executor", req, intent, artifact)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := store.prepareArtifactReviewV2("vault-executor", req, intent, artifact)
	if err != nil || duplicate.Nonce != first.Nonce {
		t.Fatalf("non-idempotent review: %v", err)
	}
	_, restored, _, err := store.requirePreparedReviewV2("vault-executor", req.RequestID)
	if err != nil || restored.Digest != intent.Digest {
		t.Fatalf("review reload: %v", err)
	}
	changed := artifact
	changed.StateSlot++
	if _, err := store.prepareArtifactReviewV2("vault-executor", req, intent, changed); err == nil {
		t.Fatal("accepted changed immutable review")
	}
	now = now.Add(24 * time.Hour)
	if _, _, _, err := store.requirePreparedReviewV2("vault-executor", req.RequestID); err == nil {
		t.Fatal("accepted expired Vault review")
	}
}
