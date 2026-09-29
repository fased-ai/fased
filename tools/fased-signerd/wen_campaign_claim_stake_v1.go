package main

import (
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

type wenCampaignClaimStakeResultV1 struct {
	Amounts                                              wenCampaignClaimAmountsV1
	NextPosition, NextTotal, NextCustodied, EffectiveDay uint64
	RentBytes                                            []uint64
}

// Unsigned direct-stake candidate only. Launch activation, authenticated combined
// RPC snapshot, rent/fee preparation and owner approval remain external gates.
func buildWENCampaignClaimStakeV1(v signerWENStakingIntentV1, minimumNet uint64, s wenCampaignClaimSnapshotV1, h wenStakingHistorySnapshotV1) (solana.Instruction, wenCampaignClaimStakeResultV1, error) {
	var out wenCampaignClaimStakeResultV1
	bad := errors.New("invalid campaign claim-to-stake")
	fail := func() (solana.Instruction, wenCampaignClaimStakeResultV1, error) {
		return nil, wenCampaignClaimStakeResultV1{}, bad
	}
	if minimumNet == 0 || v.Operation != "deposit" || v.ProgramID != s.Program.String() || v.Sale != s.Economy.String() || v.Mint != s.Mint.Address.String() || s.Slot != h.Slot || len(s.Windows) == 0 || v.TokenAccount != s.Windows[0].Vault.Address.String() {
		return fail()
	}
	stake, e := buildWENStakingInstructionV1(v, s.Owner)
	if e != nil {
		return fail()
	}
	a := stake.Accounts()
	pool, custody := a[3].PublicKey, a[7].PublicKey
	if s.Destination.Address != custody {
		return fail()
	}
	base, amounts, e := validateWENCampaignClaimDestinationV1(s, pool)
	if e != nil {
		return fail()
	}
	if amounts.Net < minimumNet || v.Amount != strconv.FormatUint(amounts.Gross, 10) {
		return fail()
	}
	history, e := validateWENStakingHistoryV1(v, s.Owner, h)
	if e != nil {
		return fail()
	}
	if _, _, e = validateWENSatCustodyV1(&s.Destination, custody, s.Mint.Address, pool, s.Slot, history.PoolCustodied); e != nil {
		return fail()
	}
	for _, n := range []uint64{history.PositionAmount, history.PoolNext, history.PoolCustodied} {
		if amounts.Net > ^uint64(0)-n {
			return fail()
		}
	}
	keys := base.Accounts()
	keys[0] = solana.Meta(s.Owner).WRITE().SIGNER()
	for _, i := range []int{1, 2, 3, 4, 5, 6, 10, 12, 13, 14} {
		keys = append(keys, a[i])
	}
	var issuer solana.PublicKey
	copy(issuer[:], s.Position.Data[48:80])
	tail, e := wenCampaignAccountingTailV1(s.Program, s.Economy, issuer, s.Windows[0].Window.Address)
	if e != nil {
		return fail()
	}
	keys = append(keys, tail...)
	// History and total point aliases are legitimate only when derived for the
	// same effective day; the staking validator has checked both copies.
	data := make([]byte, 34)
	data[0] = 164
	data[1] = s.Mask
	for i, n := range []uint64{minimumNet, history.EffectiveDay - 1, mustStakeUint(v.Last), mustStakeUint(v.AggregateFrom)} {
		binary.LittleEndian.PutUint64(data[2+8*i:], n)
	}
	out = wenCampaignClaimStakeResultV1{Amounts: amounts, NextPosition: history.PositionAmount + amounts.Net, NextTotal: history.PoolNext + amounts.Net, NextCustodied: history.PoolCustodied + amounts.Net, EffectiveDay: history.EffectiveDay, RentBytes: history.RentBytes}
	return solana.NewInstruction(s.Program, keys, data), out, nil
}
func mustStakeUint(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }

func compileWENCampaignClaimStakeV1(ix solana.Instruction, owner solana.PublicKey, hash solana.Hash, current, last uint64) ([]byte, error) {
	if ix == nil || owner.IsZero() || hash == (solana.Hash{}) || current >= last {
		return nil, errors.New("invalid direct-stake lifetime")
	}
	limit := make([]byte, 5)
	limit[0] = 2
	binary.LittleEndian.PutUint32(limit[1:], 400000)
	budget := solana.NewInstruction(solana.MustPublicKeyFromBase58("ComputeBudget111111111111111111111111111111"), nil, limit)
	tx, e := solana.NewTransaction([]solana.Instruction{budget, ix}, hash, solana.TransactionPayer(owner))
	if e != nil {
		return nil, e
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	message, e := tx.Message.MarshalBinary()
	if e != nil {
		return nil, e
	}
	if len(message)+65 > 1232 || tx.Message.Header.NumRequiredSignatures != 1 {
		return nil, errors.New("invalid direct-stake size/signers")
	}
	return message, nil
}
