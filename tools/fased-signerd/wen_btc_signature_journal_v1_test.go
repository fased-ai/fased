package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestWENBTCSignatureJournal(t *testing.T) {
	for _, name := range []string{"valid", "restart", "revoked", "wrong-key", "changed-message", "malformed", "before-fence", "missing-wallet"} {
		t.Run(name, func(t *testing.T) {
			s, r := wenStateFixture(t)
			pub, key, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			// Synthetic signing key only; no owner key or production signing API used.
			r.WalletPublicKey = solana.PublicKeyFromBytes(pub).String()
			if name == "missing-wallet" {
				r.WalletPublicKey = ""
			}
			raw, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw) }); err != nil {
				t.Fatal(err)
			}
			message := []byte("exact message already bound by internal signing fence")
			if name != "before-fence" {
				if err := s.beginWENSigningV1("state-request", r.Digest, wenHashV1(message)); err != nil {
					t.Fatal(err)
				}
			}
			if name == "wrong-key" {
				_, key, err = ed25519.GenerateKey(rand.Reader)
				if err != nil {
					t.Fatal(err)
				}
			}
			var sig solana.Signature
			copy(sig[:], ed25519.Sign(key, message))
			signature := sig.String()
			if name == "changed-message" {
				message = append(message, '!')
			}
			if name == "malformed" {
				signature = "invalid"
			}
			if name == "revoked" {
				if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketSignerPoliciesV2).Delete([]byte(r.WalletID)) }); err != nil {
					t.Fatal(err)
				}
			}
			err = s.recordWENSignatureV1("state-request", r.Digest, message, signature)
			success := name == "valid" || name == "restart" || name == "revoked"
			if (err == nil) != success {
				t.Fatalf("unexpected signature record: %v", err)
			}
			if success {
				if name == "restart" {
					persisted := wenRestartRecord(t, s, "state-request")
					path := s.db.Path()
					if err := s.Close(); err != nil {
						t.Fatal(err)
					}
					verifyWENFreshProcess(t, path, "state-request", persisted)
					reopened, err := openSignerStoreV2(path)
					if err != nil {
						t.Fatal(err)
					}
					defer reopened.Close()
					s = reopened
				}
				if err := s.recordWENSignatureV1("state-request", r.Digest, message, signature); err != nil {
					t.Fatal("journal retry", err)
				}
				saved := readWENState(t, s)
				if saved.State != "signed" || saved.Signature != signature || !bytes.Equal(saved.SignedMessage, message) {
					t.Fatal("lost signed identity")
				}
				message[0] ^= 1
				if bytes.Equal(readWENState(t, s).SignedMessage, message) {
					t.Fatal("caller mutated journal")
				}
				if err := s.cancelWENReservationV1("state-request", r.Digest); err == nil {
					t.Fatal("signed reservation released")
				}
				if err := s.beginWENSigningV1("state-request", r.Digest, wenHashV1(message)); err == nil {
					t.Fatal("signed request signed again")
				}
			} else {
				saved := readWENState(t, s)
				if saved.Signature != "" || len(saved.SignedMessage) != 0 {
					t.Fatal("failed journal changed record")
				}
			}
			for scope, amount := range r.Scopes {
				got, err := s.wenBudgetReservedV1(scope)
				if err != nil || got != amount {
					t.Fatal("journal changed budgets", got, err)
				}
			}
		})
	}
}
