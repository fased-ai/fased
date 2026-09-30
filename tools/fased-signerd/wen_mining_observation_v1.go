package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"strconv"
)

type wenMiningRecoveryRPCV1 interface {
	signerWENBTCReconcileRPCV1
	GetMultipleAccountsWithOpts(context.Context, []solana.PublicKey, *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error)
}

// A finalized later observation, not transaction-time account data. A commit may
// already have a valid reveal; neither observation proves settlement or an award.
func (s *signerStoreV2) observeWENMiningEntryV1(ctx context.Context, c wenMiningRecoveryRPCV1, request, digest string) error {
	bad := errors.New("mining finalized entry observation unavailable or changed")
	var saved wenBudgetReservationV1
	if err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("request:"+request)), &saved)
	}); err != nil {
		return err
	}
	if saved.Digest != digest || saved.State != "finalized-success" || !saved.SuccessBudgetSettled || saved.MiningEntry == nil || saved.MiningIntent == nil || saved.MiningPins == nil {
		return bad
	}
	if validateWENMiningIntentV1(*saved.MiningIntent) != nil || len(saved.MiningEntry.Data) != 272 || wenHashV1(saved.MiningEntry.Data) != saved.MiningIntent.EntrySHA256 || saved.MiningPins.ProgramID != saved.MiningIntent.ProgramID || saved.MiningPins.Genesis != saved.Genesis {
		return bad
	}
	wallet, parseErr := solana.PublicKeyFromBase58(saved.WalletPublicKey)
	if parseErr != nil || wallet.IsZero() {
		return bad
	}
	if _, err := wenSignedWireV1(saved, saved.SignedMessage); err != nil {
		return err
	}
	if saved.MiningObservedSlot >= saved.OutcomeSlot && wenReservationHashV1(saved.MiningObservedSHA256) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	chain, err := c.GetGenesisHash(ctx)
	if err != nil {
		return err
	}
	if chain.String() != saved.Genesis {
		return bad
	}
	v := *saved.MiningIntent
	pins := *saved.MiningPins
	program := solana.MustPublicKeyFromBase58(v.ProgramID)
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	pd, _, err := solana.FindProgramAddress([][]byte{program[:]}, loader)
	if err != nil {
		return err
	}
	keys := []solana.PublicKey{solana.MustPublicKeyFromBase58(v.Entry), program, pd}
	min := saved.OutcomeSlot
	page, err := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if err != nil {
		return err
	}
	if page == nil || len(page.Value) != 3 || page.Context.Slot < min {
		return bad
	}
	accounts := make([]*signerWENBTCAccountV1, 3)
	for i, a := range page.Value {
		if a == nil || a.Data == nil {
			return bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: page.Context.Slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	if verifyWENBTCDeploymentV1(signerWENBTCPinsV1{ProgramID: pins.ProgramID, CodeSHA256: pins.CodeSHA256, DeploymentSlot: pins.DeploymentSlot, UpgradeAuthority: pins.UpgradeAuthority}, page.Context.Slot, accounts[1], accounts[2]) != nil {
		return bad
	}
	observed := accounts[0]
	if observed.Owner != program || observed.Executable || len(observed.Data) != 272 {
		return bad
	}
	expected := append([]byte(nil), saved.MiningEntry.Data...)
	tx, err := solana.TransactionFromBytes(append(append([]byte{1}, make([]byte, 64)...), saved.SignedMessage...))
	if err != nil || len(tx.Message.Instructions) != 1 {
		return bad
	}
	data := tx.Message.Instructions[0].Data
	if v.Operation == "commit" {
		if len(data) != 33 {
			return bad
		}
		expected[9] = 1
		copy(expected[200:232], data[1:])
	} else {
		if len(data) != 41 {
			return bad
		}
		expected[10] = 1
		copy(expected[232:], data[1:])
	}
	if !bytes.Equal(expected, observed.Data) {
		if v.Operation != "commit" || observed.Data[10] != 1 {
			return bad
		}
		// Validate later reveal against the originally signed commitment and domain.
		committed := append([]byte(nil), expected...)
		copyIntent := v
		copyIntent.Operation = "reveal"
		copyIntent.EntrySHA256 = wenHashV1(committed)
		open, _ := strconv.ParseUint(v.Open, 10, 64)
		snap := *saved.MiningEntry
		snap.Data = committed
		snap.Now = open + 180
		if _, err = prepareWENMiningInstructionV1(copyIntent, wallet, snap, observed.Data[232:]); err != nil {
			return bad
		}
		expected[10] = 1
		copy(expected[232:], observed.Data[232:])
		if !bytes.Equal(expected, observed.Data) {
			return bad
		}
	}
	reference, err := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return err
	}
	if reference < page.Context.Slot {
		return bad
	}
	after, err := c.GetGenesisHash(ctx)
	if err != nil {
		return err
	}
	if after != chain {
		return bad
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return s.changeWENReservationV1(request, digest, func(_ *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "finalized-success" || r.Signature != saved.Signature || r.OutcomeSlot != saved.OutcomeSlot {
			return bad
		}
		r.MiningObservedSlot = page.Context.Slot
		r.MiningObservedSHA256 = wenHashV1(observed.Data)
		return nil
	})
}
