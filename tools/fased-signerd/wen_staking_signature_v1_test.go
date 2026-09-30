package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENStakingSignaturePersistenceV1(t *testing.T) {
	for _, mode := range []string{"valid", "restart", "wrong-key", "changed-message", "changed-binding", "before-fence", "submission"} {
		t.Run(mode, func(t *testing.T) {
			s, r := wenStateFixture(t)
			pub, key, e := ed25519.GenerateKey(rand.Reader)
			if e != nil {
				t.Fatal(e)
			}
			wallet := solana.PublicKeyFromBytes(pub)
			v := stakingReviewFixture(t).Intent
			r.WalletPublicKey = wallet.String()
			r.StakingIntent = &v
			r.WalletClaims = map[string]uint64{"solana:native": 7000}
			ix, e := buildWENStakingInstructionV1(v, wallet)
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
			r.StakingPrepared = &wenStakingMessageBindingV1{Message: append([]byte(nil), msg...), Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), Slot: 100, Fee: 5000, Rent: 2000, LastValidHeight: 200}
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
				saved.StakingPrepared.Message[0] ^= 1
				save(saved)
			}
			e = s.recordWENSignatureV1("state-request", r.Digest, msg, signature.String())
			success := mode == "valid" || mode == "restart" || mode == "submission"
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
			if mode == "submission" {
				saved := readWENState(t, s)
				p := &wenStakingPreparedV1{message: msg, wallet: wallet, review: wenStakingReviewedConfigV1{reviewSHA: saved.StakingPrepared.ReviewSHA}}
				wire, err := s.commitWENStakingSubmissionV1("state-request", r.Digest, saved, p)
				if err != nil || !bytes.Equal(wire[65:], msg) {
					t.Fatal("submission fence", err)
				}
				if readWENState(t, s).State != "submission-uncertain" {
					t.Fatal("uncertainty not persisted")
				}
				if _, err = s.commitWENStakingSubmissionV1("state-request", r.Digest, saved, p); err == nil {
					t.Fatal("resubmission accepted")
				}
				persisted := wenRestartRecord(t, s, "state-request")
				path := s.db.Path()
				if err = s.Close(); err != nil {
					t.Fatal(err)
				}
				verifyWENFreshProcess(t, path, "state-request", persisted)
				s, err = openSignerStoreV2(path)
				if err != nil {
					t.Fatal(err)
				}
				defer s.Close()
				if _, err = s.commitWENStakingSubmissionV1("state-request", r.Digest, saved, p); err == nil {
					t.Fatal("restart resubmission accepted")
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
			saved.StakingPrepared.Message = append([]byte(nil), saved.StakingPrepared.Message...)
			saved.StakingPrepared.Message[0] ^= 1
			if _, e = wenSignedWireV1(saved, msg); e == nil {
				t.Fatal("corrupt binding recovered")
			}
		})
	}
}
