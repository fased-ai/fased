package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"strings"
	"testing"
)

func TestWENNativeClaimSignaturePersistenceV1(t *testing.T) {
	for _, mode := range []string{"valid", "restart", "wrong-key", "changed-message", "changed-binding", "before-fence", "submission", "submission-mismatch", "submission-net", "submission-fee", "submission-slot", "submission-review"} {
		t.Run(mode, func(t *testing.T) {
			s, r := wenStateFixture(t)
			pub, key, e := ed25519.GenerateKey(rand.Reader)
			if e != nil {
				t.Fatal(e)
			}
			wallet := solana.PublicKeyFromBytes(pub)
			v := nativeClaimIntentFixture()
			v.MinFinalizedSlot = "100"
			v.ExpiresSlot = "200"
			v.MaxRentLamports = "1000"
			r.WalletPublicKey = wallet.String()
			r.NativeClaimIntent = &v
			r.WalletClaims = map[string]uint64{"solana:native": 6000}
			ix, e := buildWENNativeClaimInstructionV1(v, wallet)
			if e != nil {
				t.Fatal(e)
			}
			block := solana.MustHashFromBase58(v.Genesis)
			tx, e := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(wallet))
			if e != nil {
				t.Fatal(e)
			}
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, e := tx.Message.MarshalBinary()
			if e != nil {
				t.Fatal(e)
			}
			r.NativeClaimPrepared = &wenNativeClaimMessageBindingV1{Gross: 250, TransferFee: 8, Net: 242, Weight: 25, Message: append([]byte(nil), msg...), Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), StateHash: wenHashV1([]byte("state")), Slot: 100, Fee: 5000, Rent: 1000, LastValidHeight: 200}
			all, e := tx.Message.GetAllKeys()
			if e != nil {
				t.Fatal(e)
			}
			keys := []string{}
			for _, k := range all {
				keys = append(keys, k.String())
			}
			save := func(r wenBudgetReservationV1) {
				b, e := json.Marshal(r)
				if e != nil {
					t.Fatal(e)
				}
				if e = s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), b) }); e != nil {
					t.Fatal(e)
				}
			}
			save(r)
			if mode != "before-fence" {
				if e = s.beginWENSigningAccountsV1("state-request", r.Digest, wenHashV1(msg), keys, 100); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "wrong-key" {
				_, key, e = ed25519.GenerateKey(rand.Reader)
				if e != nil {
					t.Fatal(e)
				}
			}
			var signature solana.Signature
			copy(signature[:], ed25519.Sign(key, msg))
			if mode == "changed-message" {
				msg = append([]byte(nil), msg...)
				msg[0] ^= 1
			}
			if mode == "changed-binding" {
				saved := readWENState(t, s)
				saved.NativeClaimPrepared.Message[0] ^= 1
				save(saved)
			}
			e = s.recordWENSignatureV1("state-request", r.Digest, msg, signature.String())
			success := mode == "valid" || mode == "restart" || strings.HasPrefix(mode, "submission")
			if (e == nil) != success {
				t.Fatal("unexpected journal", e)
			}
			if !success {
				return
			}
			if mode == "restart" {
				persisted := wenRestartRecord(t, s, "state-request")
				path := s.db.Path()
				if e = s.Close(); e != nil {
					t.Fatal(e)
				}
				verifyWENFreshProcess(t, path, "state-request", persisted)
				s, e = openSignerStoreV2(path)
				if e != nil {
					t.Fatal(e)
				}
				defer s.Close()
			}
			if e = s.recordWENSignatureV1("state-request", r.Digest, msg, signature.String()); e != nil {
				t.Fatal("idempotent persistence", e)
			}

			if strings.HasPrefix(mode, "submission") {
				saved := readWENState(t, s)
				b := saved.NativeClaimPrepared
				p := &wenNativeClaimPreparedV1{message: msg, wallet: wallet, blockhash: b.Blockhash, review: wenNativeClaimReviewedConfigV1{reviewSHA: b.ReviewSHA}, fee: b.Fee, rent: b.Rent, total: b.Fee + b.Rent, lastValidHeight: b.LastValidHeight, slot: b.Slot, state: wenNativeClaimReadbackV1{Allocation: wenNativeClaimAllocationV1{Gross: 250, Fee: 8, Net: 242, Weight: 25}, StateHash: b.StateHash}}
				if mode == "submission-mismatch" {
					p.state.StateHash = wenHashV1([]byte("changed"))
				}
				switch mode {
				case "submission-net":
					p.state.Allocation.Net++
				case "submission-fee":
					p.state.Allocation.Fee++
				case "submission-slot":
					p.slot--
				case "submission-review":
					p.review.reviewSHA = wenHashV1([]byte("other"))
				}
				wire, e := s.commitWENNativeClaimSubmissionV1("state-request", r.Digest, saved, p)
				if mode != "submission" {
					if e == nil {
						t.Fatal("changed preparation submitted")
					}
					if readWENState(t, s).State != "signed" {
						t.Fatal("failed commit mutated state")
					}
					return
				}
				if e != nil || !bytes.Equal(wire[65:], msg) || readWENState(t, s).State != "submission-uncertain" {
					t.Fatal("uncertainty commit", e)
				}
				if _, e = s.commitWENNativeClaimSubmissionV1("state-request", r.Digest, saved, p); e == nil {
					t.Fatal("duplicate submission")
				}
				persisted := wenRestartRecord(t, s, "state-request")
				path := s.db.Path()
				if e = s.Close(); e != nil {
					t.Fatal(e)
				}
				verifyWENFreshProcess(t, path, "state-request", persisted)
				s, e = openSignerStoreV2(path)
				if e != nil {
					t.Fatal(e)
				}
				defer s.Close()
				if _, e = s.commitWENNativeClaimSubmissionV1("state-request", r.Digest, saved, p); e == nil {
					t.Fatal("restart resubmission")
				}
			}
			saved := readWENState(t, s)
			wire, e := wenSignedWireV1(saved, msg)
			if e != nil || len(wire) != len(msg)+65 || !bytes.Equal(wire[65:], msg) {
				t.Fatal("wire recovery", e)
			}
			if e = s.beginWENSigningAccountsV1("state-request", r.Digest, wenHashV1(msg), keys, 100); e == nil {
				t.Fatal("replacement signing accepted")
			}
			if e = s.cancelWENReservationV1("state-request", r.Digest); e == nil {
				t.Fatal("signed cancellation")
			}
			saved.NativeClaimPrepared.Message = append([]byte(nil), saved.NativeClaimPrepared.Message...)
			saved.NativeClaimPrepared.Message[0] ^= 1
			if _, e = wenSignedWireV1(saved, msg); e == nil {
				t.Fatal("corrupt binding recovered")
			}
		})
	}
}
