package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

func miningClaimStateFixture(t *testing.T, override ...signerWENMiningClaimIntentV1) (signerWENMiningClaimIntentV1, solana.PublicKey, wenMiningClaimSnapshotV1) {
	return miningClaimStateOwnedFixture(t, solana.PublicKey{5}, override...)
}
func miningClaimStateOwnedFixture(t *testing.T, owner solana.PublicKey, override ...signerWENMiningClaimIntentV1) (signerWENMiningClaimIntentV1, solana.PublicKey, wenMiningClaimSnapshotV1) {
	t.Helper()
	v := miningClaimIntentFixture()
	if len(override) > 0 {
		v = override[0]
	}
	ix, e := buildWENMiningClaimInstructionV1(v, owner)
	if e != nil {
		t.Fatal(e)
	}
	p := ix.ProgramID()
	a := ix.Accounts()
	sale, offer, entry := a[1].PublicKey, a[2].PublicKey, a[5].PublicKey
	makeAccount := func(seed, magic string, length int, keys []solana.PublicKey, parts ...[]byte) *signerWENBTCAccountV1 {
		k, b, _ := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, parts...), p)
		d := make([]byte, length)
		copy(d, magic)
		d[8] = 1
		d[10] = 1
		d[11] = b
		for i, k := range keys {
			copy(d[16+i*32:], k[:])
		}
		return &signerWENBTCAccountV1{Address: k, Owner: p, Slot: 2, Data: d}
	}
	roster := makeAccount("wen-mining-roster-v1", "WENMRST1", 200, []solana.PublicKey{p, sale, offer}, sale[:], offer[:])
	for o, n := range map[int]uint64{112: 1000, 120: 100, 128: 1, 136: 999, 144: 1, 152: 100, 192: 100} {
		binary.LittleEndian.PutUint64(roster.Data[o:], n)
	}
	copy(roster.Data[160:], entry[:])
	id := make([]byte, 8)
	id[0] = 1
	fund, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-mining-lifecycle-fund-v1"), sale[:], id}, p)
	vault, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-allocation-v1"), sale[:], {3}}, p)
	receipt := makeAccount("wen-mining-progress-v1", "WENMST01", 352, []solana.PublicKey{p, sale, offer, roster.Address, fund, vault}, sale[:], offer[:])
	for o, n := range map[int]uint64{208: 1, 216: 1000, 224: 1900, 232: 1, 240: 100, 248: 20} {
		binary.LittleEndian.PutUint64(receipt.Data[o:], n)
	}
	claim := makeAccount("wen-mining-claim-v1", "WENMCLM1", 192, []solana.PublicKey{p, sale, offer, entry, owner}, sale[:], entry[:])
	claim.Data[10] = 0
	binary.LittleEndian.PutUint64(claim.Data[176:], 100)
	binary.LittleEndian.PutUint64(claim.Data[184:], 20)
	return v, owner, wenMiningClaimSnapshotV1{Slot: 2, Now: 1900, Open: 1000, Capacity: 100, MinimumFill: 1, Roster: roster, Receipt: receipt, Claim: claim}
}
func TestWENMiningClaimSettlement(t *testing.T) {
	changes := map[string]func(*signerWENMiningClaimIntentV1, *wenMiningClaimSnapshotV1){
		"mixed-slot": func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) { s.Claim.Slot++ },
		"stale":      func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) { s.Slot = 0 },
		"future":     func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) { s.Now = 1899 },
		"ordinal":    func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) { v.Ordinal = "1" },
		"gross":      func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) { v.ExpectedGross = "101" },
		"paid": func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) {
			s.Claim.Data[10] = 1
			binary.LittleEndian.PutUint64(s.Receipt.Data[312:], 100)
			binary.LittleEndian.PutUint64(s.Receipt.Data[328:], 1)
		},
	}
	for _, target := range []string{"roster", "receipt", "claim"} {
		for _, kind := range []string{"address", "owner", "executable", "short", "version", "bump", "reserved", "domain"} {
			target, kind := target, kind
			changes[target+"-"+kind] = func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) {
				a := s.Roster
				if target == "receipt" {
					a = s.Receipt
				}
				if target == "claim" {
					a = s.Claim
				}
				switch kind {
				case "address":
					a.Address = solana.PublicKey{9}
				case "owner":
					a.Owner = solana.PublicKey{9}
				case "executable":
					a.Executable = true
				case "short":
					a.Data = a.Data[:1]
				case "version":
					a.Data[8] = 2
				case "bump":
					a.Data[11] ^= 1
				case "reserved":
					a.Data[12] = 1
				case "domain":
					a.Data[16] ^= 1
				}
			}
		}
	}
	for _, offset := range []int{136, 144, 152, 192} {
		o := offset
		changes["roster-number-"+strconv.Itoa(o)] = func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) {
			binary.LittleEndian.PutUint64(s.Roster.Data[o:], 1000)
		}
	}
	for _, offset := range []int{208, 216, 232, 312, 320, 328, 336, 344} {
		o := offset
		changes["receipt-number-"+strconv.Itoa(o)] = func(v *signerWENMiningClaimIntentV1, s *wenMiningClaimSnapshotV1) {
			binary.LittleEndian.PutUint64(s.Receipt.Data[o:], 2000)
		}
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			v, w, s := miningClaimStateFixture(t)
			change(&v, &s)
			if _, e := validateWENMiningClaimSettlementV1(v, w, s); e == nil {
				t.Fatal("accepted invalid settlement")
			}
		})
	}
	for _, op := range []string{"sol", "sat"} {
		t.Run(op, func(t *testing.T) {
			v, w, s := miningClaimStateFixture(t)
			v.Operation = op
			if op == "sat" {
				d := solana.PublicKey{4}.String()
				v.Destination = &d
				v.ExpectedGross = "20"
				v.MinimumReceived = "19"
			}
			out, e := validateWENMiningClaimSettlementV1(v, w, s)
			if e != nil || out.Capital != 100 || out.SATGross != 20 {
				t.Fatal(out, e)
			}
		})
	}
	// A paid other leg does not prevent claiming this leg.
	v, w, s := miningClaimStateFixture(t)
	s.Claim.Data[10] = 2
	binary.LittleEndian.PutUint64(s.Receipt.Data[320:], 20)
	binary.LittleEndian.PutUint64(s.Receipt.Data[336:], 1)
	if _, e := validateWENMiningClaimSettlementV1(v, w, s); e != nil {
		t.Fatal(e)
	}
}
func TestWENMiningClaimSettlementPortableParity(t *testing.T) {
	v, w, s := miningClaimStateFixture(t)
	ix, _ := buildWENMiningClaimInstructionV1(v, w)
	account := func(a *signerWENBTCAccountV1) map[string]any {
		return map[string]any{"address": a.Address.String(), "owner": a.Owner.String(), "executable": a.Executable, "data": a.Data}
	}
	input := map[string]any{"s": map[string]any{"roster": account(s.Roster), "receipt": account(s.Receipt), "claim": account(s.Claim)}, "e": map[string]any{"program": v.ProgramID, "economy": v.Economy, "offer": ix.Accounts()[2].PublicKey.String(), "entry": ix.Accounts()[5].PublicKey.String(), "owner": w.String(), "id": "1", "open": "1000", "capacity": "100", "minimumFill": "1", "ordinal": "0"}}
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../.."))
	output := filepath.Join(t.TempDir(), "result.json")
	script := `import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';const root=process.argv[1],sdk=await import(pathToFileURL(root+'/node_modules/@solana/kit/dist/index.node.mjs'));const {validateMiningClaimSettlement}=await import(pathToFileURL(root+'/tools/fased-signerd/testdata/wen-protocol/client/mining-claim-settlement.mjs'));const {s,e}=JSON.parse(readFileSync(0,'utf8'));for(const a of Object.values(s))a.data=new Uint8Array(Buffer.from(a.data,'base64'));for(const k of ['id','open','capacity','minimumFill','ordinal'])e[k]=BigInt(e[k]);const out=await validateMiningClaimSettlement(sdk,s,e);writeFileSync(process.argv[2],JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v));`
	raw, _ := json.Marshal(input)
	cmd := exec.Command("node", "--input-type=module", "-e", script, root, output)
	cmd.Stdin = bytes.NewReader(raw)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("%v %s", e, out)
	}
	raw, e := os.ReadFile(output)
	if e != nil {
		t.Fatal(e)
	}
	var out struct {
		Capital string `json:"capital"`
		Claim   struct {
			SOL string `json:"solGross"`
			SAT string `json:"satGross"`
		} `json:"claim"`
	}
	if e = json.Unmarshal(raw, &out); e != nil || out.Capital != "100" || out.Claim.SOL != "100" || out.Claim.SAT != "20" {
		t.Fatal(string(raw), e)
	}
}

func TestWENMiningClaimSettlementBoundaries(t *testing.T) {
	v, w, s := miningClaimStateFixture(t)
	copy(s.Receipt.Data, "WENMST02")
	binary.LittleEndian.PutUint64(s.Receipt.Data[304:], ^uint64(0))
	binary.LittleEndian.PutUint64(s.Receipt.Data[344:], 368934881474191032)
	out, e := validateWENMiningClaimSettlementV1(v, w, s)
	if e != nil || !out.Routed {
		t.Fatal("overflow-safe routed allocation", e)
	}
	v.ExpectedGross = "0"
	v.MinimumReceived = "0"
	binary.LittleEndian.PutUint64(s.Claim.Data[176:], 0)
	if _, e = validateWENMiningClaimSettlementV1(v, w, s); e != nil {
		t.Fatal("zero SOL leg must remain closable", e)
	}
	binary.LittleEndian.PutUint64(s.Claim.Data[184:], 0)
	if _, e = validateWENMiningClaimSettlementV1(v, w, s); e == nil {
		t.Fatal("entirely empty claim accepted")
	}
	v, w, s = miningClaimStateFixture(t)
	s.Roster.Data = append(s.Roster.Data, s.Roster.Data[160:]...)
	binary.LittleEndian.PutUint64(s.Roster.Data[144:], 2)
	binary.LittleEndian.PutUint64(s.Roster.Data[152:], 200)
	s.Capacity = 200
	binary.LittleEndian.PutUint64(s.Roster.Data[120:], 200)
	if _, e = validateWENMiningClaimSettlementV1(v, w, s); e == nil {
		t.Fatal("duplicate roster entry accepted")
	}
}
