package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
	"reflect"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenBondLookupPinV2 struct {
	Key    solana.PublicKey
	Digest string
}

type wenBondPurchaseReadPolicyV2 struct {
	Deployment, Venue, Router, Oracle           signerWENBTCPinsV1
	Nonce, MinimumSlot, ExpiresSlot, MaxSlotLag uint64
	QuoteSHA256                                 string
	Route                                       signerWENBTCRouteV1
	LookupPins                                  []wenBondLookupPinV2
}
type wenBondPurchaseSnapshotV2 struct {
	Pins                                           wenBondPurchasePinsV2
	Quote                                          wenBondAccountV2
	Source                                         signerWENBTCAccountV1
	Lookups                                        []*signerWENBTCAccountV1
	Slot, ReferenceSlot, Now, Rent, RefundableRent uint64
	StateSHA256                                    string
}

func wenBondPurchaseIndicesV2(p wenBondPinsV2, slot uint64, index, root, entry *signerWENBTCAccountV1) (uint64, uint64, error) {
	bad := errors.New("Bond indexed accounting rejected")
	source, sb, e := wenBondKeyV2(p.Program, "wen-bond-owner-v1", p.Sale[:], p.Owner[:])
	if e != nil {
		return 0, 0, e
	}
	domain, db, e := wenBondKeyV2(p.Program, "wen-accounting-domain-v1", p.Sale[:], []byte{2})
	if e != nil {
		return 0, 0, e
	}
	ek, eb, e := wenBondKeyV2(p.Program, "wen-accounting-source-v1", domain[:], source[:])
	if e != nil {
		return 0, 0, e
	}
	var count uint64
	if index != nil {
		d := index.Data
		x := make([]byte, 88)
		copy(x, []byte("WENBOI01"))
		x[8] = 1
		x[11] = sb
		copy(x[16:], p.Sale[:])
		copy(x[48:], p.Owner[:])
		if len(d) != 88 {
			return 0, 0, bad
		}
		count = binary.LittleEndian.Uint64(d[80:])
		binary.LittleEndian.PutUint64(x[80:], count)
		if index.Address != source || index.Owner != p.Program || index.Executable || index.Slot != slot || !bytes.Equal(d, x) || count == ^uint64(0) {
			return 0, 0, bad
		}
	}
	if root == nil {
		if entry != nil || count != 0 {
			return 0, 0, bad
		}
		return count, 0, nil
	}
	d := root.Data
	if len(d) != 104 {
		return 0, 0, bad
	}
	n, revision := binary.LittleEndian.Uint64(d[56:]), binary.LittleEndian.Uint64(d[64:])
	x := make([]byte, 104)
	copy(x, []byte("WENDOM01"))
	x[8] = 1
	x[10] = 2
	x[11] = db
	copy(x[16:], p.Sale[:])
	binary.LittleEndian.PutUint64(x[48:], 1)
	binary.LittleEndian.PutUint64(x[56:], n)
	binary.LittleEndian.PutUint64(x[64:], revision)
	x[72] = 1
	if root.Address != domain || root.Owner != p.Program || root.Executable || root.Slot != slot || revision < n || !bytes.Equal(d, x) {
		return 0, 0, bad
	}
	if entry == nil {
		if count != 0 || n == ^uint64(0) {
			return 0, 0, bad
		}
		return count, n, nil
	}
	d = entry.Data
	if len(d) != 128 {
		return 0, 0, bad
	}
	i := binary.LittleEndian.Uint64(d[80:])
	x = make([]byte, 128)
	copy(x, []byte("WENDS001"))
	x[8] = 1
	x[11] = eb
	copy(x[16:], domain[:])
	copy(x[48:], source[:])
	binary.LittleEndian.PutUint64(x[80:], i)
	if entry.Address != ek || entry.Owner != p.Program || entry.Executable || entry.Slot != slot || i >= n || index == nil || !bytes.Equal(d, x) {
		return 0, 0, bad
	}
	return count, i, nil
}
func wenBondPurchaseAssetIndexV2(p wenBondPinsV2, slot uint64, root *signerWENBTCAccountV1) (uint64, error) {
	if root == nil {
		return 0, nil
	}
	bad := errors.New("Bond protocol asset index rejected")
	key, bump, e := wenBondKeyV2(p.Program, "wen-accounting-domain-v1", p.Sale[:], []byte{7})
	if e != nil {
		return 0, e
	}
	d := root.Data
	if len(d) != 104 {
		return 0, bad
	}
	count, revision := binary.LittleEndian.Uint64(d[56:]), binary.LittleEndian.Uint64(d[64:])
	x := make([]byte, 104)
	copy(x, []byte("WENDOM01"))
	x[8], x[10], x[11] = 1, 7, bump
	copy(x[16:], p.Sale[:])
	binary.LittleEndian.PutUint64(x[48:], 1)
	binary.LittleEndian.PutUint64(x[56:], count)
	binary.LittleEndian.PutUint64(x[64:], revision)
	x[72] = 1
	if root.Address != key || root.Owner != p.Program || root.Executable || root.Slot != slot || count == ^uint64(0) || revision < count || !bytes.Equal(d, x) {
		return 0, bad
	}
	return count, nil
}
func wenBondPurchaseRentV2(slot uint64, r *signerWENBTCAccountV1, length uint64) (uint64, error) {
	bad := errors.New("Bond Rent sysvar rejected")
	if r == nil || r.Address != solana.SysVarRentPubkey || r.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || r.Executable || r.Slot != slot || len(r.Data) != 17 || r.Data[16] > 100 {
		return 0, bad
	}
	rate := binary.LittleEndian.Uint64(r.Data)
	threshold := math.Float64frombits(binary.LittleEndian.Uint64(r.Data[8:]))
	const exact = uint64(1<<53 - 1)
	if rate == 0 || math.IsNaN(threshold) || math.IsInf(threshold, 0) || threshold < 1 || threshold > float64(exact) || math.Trunc(threshold) != threshold || length > exact-128 || rate > exact/(128+length) {
		return 0, bad
	}
	base := rate * (128 + length)
	if uint64(threshold) > exact/base {
		return 0, bad
	}
	return base * uint64(threshold), nil
}
func readWENBondPurchaseV2(ctx context.Context, c signerWENBTCReadRPCV1, p wenBondPurchasePinsV2, policy wenBondPurchaseReadPolicyV2) (wenBondPurchaseSnapshotV2, error) {
	var out wenBondPurchaseSnapshotV2
	bad := errors.New("Bond finalized purchase admission rejected")
	b := p.Bond
	genesis := "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
	if b.Profile == "devnet-synthetic-fixture" {
		genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
	} else if b.Profile != "mainnet" {
		return out, bad
	}
	if c == nil || policy.Deployment.ProgramID != b.Program.String() || policy.ExpiresSlot <= policy.MinimumSlot || policy.ExpiresSlot-policy.MinimumSlot > 32 || policy.MaxSlotLag == 0 || policy.MaxSlotLag > 32 || !wenReservationHashV1(policy.QuoteSHA256) || len(policy.LookupPins) < 1 || len(policy.LookupPins) > 4 {
		return out, bad
	}
	// Copy authority and byte-bearing protected configuration before I/O.
	policy = cloneWENBondPurchasePolicyV2(policy)
	p.PolicyBytes = append([]byte(nil), p.PolicyBytes...)
	deployments := []signerWENBTCPinsV1{policy.Deployment, policy.Venue, policy.Router, policy.Oracle}
	for _, d := range deployments {
		if d.Genesis != genesis || d.DeploymentSlot == 0 || policy.MinimumSlot < d.DeploymentSlot || !wenReservationHashV1(d.CodeSHA256) {
			return out, bad
		}
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	network, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if network.String() != genesis {
		return out, bad
	}
	derive := func(seed string, rest ...[]byte) solana.PublicKey {
		k, _, err := wenBondKeyV2(b.Program, seed, rest...)
		if err != nil {
			e = err
		}
		return k
	}
	quoteKey := derive("wen-bond-net-quote-v1", b.Sale[:], b.Owner[:], wenBondU64V2(policy.Nonce))
	index := derive("wen-bond-owner-v1", b.Sale[:], b.Owner[:])
	domain := derive("wen-accounting-domain-v1", b.Sale[:], []byte{2})
	entry := derive("wen-accounting-source-v1", domain[:], index[:])
	assetDomain := derive("wen-accounting-domain-v1", b.Sale[:], []byte{7})
	if e != nil {
		return out, e
	}
	fetch := func(keys []solana.PublicKey, min uint64) (uint64, map[solana.PublicKey]*signerWENBTCAccountV1, error) {
		if len(keys) > 100 {
			return 0, nil, bad
		}
		page, err := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
		if err != nil {
			return 0, nil, err
		}
		if page == nil || len(page.Value) != len(keys) || page.Context.Slot < min || page.Context.Slot >= policy.ExpiresSlot || page.Context.Slot-policy.MinimumSlot > policy.MaxSlotLag {
			return 0, nil, bad
		}
		rows := map[solana.PublicKey]*signerWENBTCAccountV1{}
		for i, a := range page.Value {
			if a != nil {
				if a.Data == nil {
					return 0, nil, bad
				}
				rows[keys[i]] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Executable: a.Executable, Slot: page.Context.Slot, Data: append([]byte(nil), a.Data.GetBinary()...)}
			}
		}
		return page.Context.Slot, rows, nil
	}
	firstSlot, first, e := fetch([]solana.PublicKey{quoteKey, index, domain, entry, assetDomain, solana.SysVarClockPubkey}, policy.MinimumSlot)
	if e != nil {
		return out, e
	}
	clockTime := func(slot uint64, r *signerWENBTCAccountV1) (uint64, error) {
		if r == nil || r.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || r.Executable || len(r.Data) != 40 || binary.LittleEndian.Uint64(r.Data) != slot {
			return 0, bad
		}
		n := binary.LittleEndian.Uint64(r.Data[32:])
		if n > uint64(1<<63-1) {
			return 0, bad
		}
		return n, nil
	}
	now, e := clockTime(firstSlot, first[solana.SysVarClockPubkey])
	if e != nil {
		return out, e
	}
	p.IndexCount, p.DomainIndex, e = wenBondPurchaseIndicesV2(b, firstSlot, first[index], first[domain], first[entry])
	if e != nil {
		return out, e
	}
	q := first[quoteKey]
	if q == nil || wenHashV1(q.Data) != policy.QuoteSHA256 {
		return out, bad
	}
	record := wenBondAccountV2{q.Address, q.Owner, q.Executable, q.Data}
	if len(q.Data) != 352 {
		return out, bad
	}
	if q.Data[10] == 2 {
		p.AssetIndex, e = wenBondPurchaseAssetIndexV2(b, firstSlot, first[assetDomain])
		if e != nil {
			return out, e
		}
	}
	instructions, e := buildWENBondPurchaseV2(p, record, policy.Nonce, now, policy.Route)
	if e != nil {
		return out, e
	}
	a := instructions[0].Accounts()
	router := policy.Route.Program
	// Profile-specific CPI programs are derived by the canonical compiler.
	venue := solana.MustPublicKeyFromBase58("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C")
	oracle := solana.MustPublicKeyFromBase58("pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou")
	if b.Profile == "devnet-synthetic-fixture" {
		venue = solana.MustPublicKeyFromBase58("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb")
		oracle = router
	}
	if policy.Venue.ProgramID != venue.String() || policy.Router.ProgramID != router.String() || policy.Oracle.ProgramID != oracle.String() || router == oracle && !reflect.DeepEqual(policy.Router, policy.Oracle) {
		return out, bad
	}
	keys := []solana.PublicKey{}
	seen := map[solana.PublicKey]bool{}
	add := func(k solana.PublicKey) {
		if !seen[k] {
			keys = append(keys, k)
			seen[k] = true
		}
	}
	for _, ix := range instructions {
		for _, m := range ix.Accounts() {
			add(m.PublicKey)
		}
	}
	for _, d := range deployments {
		program, err := solana.PublicKeyFromBase58(d.ProgramID)
		if err != nil {
			return out, bad
		}
		pd, _, err := solana.FindProgramAddress([][]byte{program[:]}, solana.BPFLoaderUpgradeableProgramID)
		if err != nil {
			return out, err
		}
		add(program)
		add(pd)
	}
	for _, pin := range policy.LookupPins {
		add(pin.Key)
	}
	add(solana.SysVarClockPubkey)
	add(solana.SysVarRentPubkey)
	slot, rows, e := fetch(keys, firstSlot)
	if e != nil {
		return out, e
	}
	now, e = clockTime(slot, rows[solana.SysVarClockPubkey])
	if e != nil {
		return out, e
	}
	same := func(x, y *signerWENBTCAccountV1) bool {
		return x == nil && y == nil || x != nil && y != nil && x.Owner == y.Owner && x.Executable == y.Executable && bytes.Equal(x.Data, y.Data)
	}
	for _, k := range []solana.PublicKey{quoteKey, index, domain, entry, assetDomain} {
		if !same(first[k], rows[k]) {
			return out, bad
		}
	}
	for _, d := range deployments {
		program := solana.MustPublicKeyFromBase58(d.ProgramID)
		pd, _, _ := solana.FindProgramAddress([][]byte{program[:]}, solana.BPFLoaderUpgradeableProgramID)
		if e = verifyWENBTCDeploymentV1(d, slot, rows[program], rows[pd]); e != nil {
			return out, e
		}
	}
	if e = validateWENBondLaunchV2(b, slot, now, rows[b.Sale], rows[a[2].PublicKey]); e != nil {
		return out, e
	}
	// Required oracle, price, reserves and mint custody are authenticated records;
	// their live contractual equations are also enforced by exact-message simulation.
	for _, i := range []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18, 22, 24, 25, 26, 27} {
		r := rows[a[i].PublicKey]
		if r == nil {
			return out, bad
		}
		if i == 22 || i == 24 {
			if !r.Executable || r.Owner != solana.BPFLoaderUpgradeableProgramID && r.Owner != solana.MustPublicKeyFromBase58("BPFLoader2111111111111111111111111111111111") {
				return out, bad
			}
			continue
		}
		expectedOwner := b.Program
		switch i {
		case 5, 6:
			expectedOwner = venue
		case 7, 9:
			expectedOwner = solana.Token2022ProgramID
		case 8, 10, 11, 12, 17, 18, 25:
			expectedOwner = solana.TokenProgramID
		case 26, 27:
			expectedOwner = oracle
		}
		if r.Owner != expectedOwner || r.Executable || len(r.Data) == 0 {
			return out, bad
		}
	}
	q = rows[quoteKey]
	record = wenBondAccountV2{q.Address, q.Owner, q.Executable, q.Data}
	if _, e = buildWENBondPurchaseV2(p, record, policy.Nonce, now, policy.Route); e != nil {
		return out, e
	}
	source := rows[p.Source]
	if source == nil {
		return out, bad
	}
	quoteTerms, e := inspectWENBondQuoteV2(b, record, policy.Nonce)
	if e != nil {
		return out, e
	}
	if binary.LittleEndian.Uint64(q.Data[232:]) > slot {
		return out, bad
	}
	if _, e = wenMarketQuoteCashV1(source, p.Source, a[10].PublicKey, b.Owner, slot, quoteTerms.Cash); e != nil {
		return out, e
	}
	lookupRows := make([]*signerWENBTCAccountV1, len(policy.LookupPins))
	for i, pin := range policy.LookupPins {
		lookupRows[i] = rows[pin.Key]
	}
	if _, e = verifiedWENBTCLookupTablesV1(policy.internalLookups(), lookupRows, signerWENBTCMessageLifeV1{minimumSlot: slot, maximumSlotLag: policy.MaxSlotLag}); e != nil {
		return out, e
	}
	cashStage := derive("wen-bond-swap-cash-v1", quoteKey[:])
	btcStage := derive("wen-bond-swap-btc-v1", quoteKey[:])
	accountingStart := 28 + len(policy.Route.Accounts) + 1
	rentKeys := []solana.PublicKey{a[19].PublicKey, a[23].PublicKey, a[20].PublicKey, a[21].PublicKey, a[17].PublicKey, cashStage, btcStage, index, a[accountingStart+4].PublicKey, domain, entry, a[accountingStart+2].PublicKey, instructions[1].Accounts()[5].PublicKey}
	lengths := []uint64{288, 178, 1120, 144, 165, 165, 165, 88, 416, 104, 128, 120, 144}
	if q.Data[10] == 2 {
		rentKeys = append(rentKeys, a[accountingStart+5].PublicKey, assetDomain, a[accountingStart+7].PublicKey, a[accountingStart+8].PublicKey)
		lengths = append(lengths, 128, 104, 128, 120)
	}
	var rent, refundable uint64
	for i, k := range rentKeys {
		r := rows[k]
		if i == 0 || i == 1 || i == 5 || i == 6 || q.Data[10] == 2 && (i == 13 || i == 15 || i == 16) {
			if r != nil {
				return out, bad
			}
		}
		if r != nil {
			if r.Executable || uint64(len(r.Data)) != lengths[i] || r.Owner != b.Program && (i != 4 || r.Owner != solana.TokenProgramID) {
				return out, bad
			}
			continue
		}
		n, err := wenBondPurchaseRentV2(slot, rows[solana.SysVarRentPubkey], lengths[i])
		if err != nil {
			return out, err
		}
		if rent > ^uint64(0)-n {
			return out, bad
		}
		rent += n
		if i == 5 || i == 6 {
			refundable += n
		}
	}
	// Hash absence as well as presence; new receipt/index creation invalidates admission.
	h := sha256.New()
	for _, k := range keys {
		if k == solana.SysVarClockPubkey {
			continue
		}
		h.Write(k[:])
		r := rows[k]
		if r == nil {
			h.Write([]byte{0})
			continue
		}
		h.Write([]byte{1})
		h.Write(r.Owner[:])
		if r.Executable {
			h.Write([]byte{1})
		} else {
			h.Write([]byte{0})
		}
		h.Write(wenBondU64V2(uint64(len(r.Data))))
		h.Write(r.Data)
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return out, e
	}
	if reference < slot || reference-slot > policy.MaxSlotLag || reference >= policy.ExpiresSlot {
		return out, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if after != network || ctx.Err() != nil {
		return out, bad
	}
	return wenBondPurchaseSnapshotV2{p, record, *source, lookupRows, slot, reference, now, rent, refundable, hex.EncodeToString(h.Sum(nil))}, nil
}

func cloneWENBondPurchasePolicyV2(p wenBondPurchaseReadPolicyV2) wenBondPurchaseReadPolicyV2 {
	copyPin := func(d signerWENBTCPinsV1) signerWENBTCPinsV1 {
		if d.UpgradeAuthority != nil {
			x := *d.UpgradeAuthority
			d.UpgradeAuthority = &x
		}
		return d
	}
	p.Deployment = copyPin(p.Deployment)
	p.Venue = copyPin(p.Venue)
	p.Router = copyPin(p.Router)
	p.Oracle = copyPin(p.Oracle)
	p.Route.Data = append([]byte(nil), p.Route.Data...)
	p.Route.Accounts = append([]signerTypedAccountV2(nil), p.Route.Accounts...)
	p.LookupPins = append([]wenBondLookupPinV2(nil), p.LookupPins...)
	return p
}

func (p wenBondPurchaseReadPolicyV2) internalLookups() []signerWENBTCLookupPinV1 {
	out := make([]signerWENBTCLookupPinV1, len(p.LookupPins))
	for i, v := range p.LookupPins {
		out[i] = signerWENBTCLookupPinV1{key: v.Key, digest: v.Digest}
	}
	return out
}
