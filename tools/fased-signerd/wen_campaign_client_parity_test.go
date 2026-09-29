package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

// Compare independent Fased reconstruction with the WEN app's shared SDK.
// No RPC, owner keys, deployment admission, or signed transaction is involved.
func TestWENCampaignRetailClientParity(t *testing.T) {
	root, err := filepath.Abs("../../../token/sat/wen-genesis")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", `
import {campaignKeeperFixture} from './client/campaign-keeper-fixture.mjs';
import {createCampaignOwnerReader} from './client/campaign-owner-rpc.mjs';
import {compileCampaignOwner} from './client/campaign-owner-instruction.mjs';
const f=await campaignKeeperFixture(); f.config.identity.owner=f.id.owner;
const read=createCampaignOwnerReader(f.config), rows=[];
for(const [operation,op,amount] of [['stop',139,0n],['withdraw',138,100n],['top-up',143,100n],['top-up',143,9007199254740993n]]) {
 const p=await read(op===139?{op}:{op,amount},f.bounds);
 const blockhash=f.key(7), c=await compileCampaignOwner(f.sdk,p.snapshot,{blockhash,currentBlockHeight:20n,lastValidBlockHeight:100n});
 rows.push({operation,amount:amount.toString(),program:f.id.program,economy:f.id.economy,owner:f.id.owner,
  position:c.instruction.accounts[1].address,positionData:Buffer.from(p.snapshot.position.data).toString('hex'),
  lamports:p.snapshot.position.lamports.toString(),rent:p.snapshot.positionRent.toString(),blockhash,
  data:Buffer.from(c.instruction.data).toString('hex'),accounts:c.instruction.accounts,
  message:Buffer.from(c.transaction.messageBytes).toString('hex')});
}
console.log(JSON.stringify(rows));`)
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("retail SDK vectors: %v", err)
	}
	var rows []struct {
		Operation, Amount, Program, Economy, Owner, Position   string
		PositionData, Lamports, Rent, Blockhash, Data, Message string
		Accounts                                               []struct {
			Address string
			Role    int
		}
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 4 {
		t.Fatalf("expected four vectors, got %d", len(rows))
	}
	key := func(s string) solana.PublicKey {
		k, e := solana.PublicKeyFromBase58(s)
		if e != nil {
			t.Fatal(e)
		}
		return k
	}
	uint := func(s string) uint64 {
		v, e := strconv.ParseUint(s, 10, 64)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	decode := func(s string) []byte {
		b, e := hex.DecodeString(s)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	for _, r := range rows {
		t.Run(r.Operation+"/"+r.Amount, func(t *testing.T) {
			a := wenCampaignOwnerActionV1{Operation: r.Operation, Program: key(r.Program), Economy: key(r.Economy), Position: key(r.Position), Amount: uint(r.Amount)}
			s := wenCampaignPositionV1{Address: a.Position, Owner: a.Program, Data: decode(r.PositionData), Lamports: uint(r.Lamports), Rent: uint(r.Rent)}
			ix, e := buildWENCampaignOwnerV1(a, key(r.Owner), s)
			if e != nil {
				t.Fatal(e)
			}
			data, e := ix.Data()
			if e != nil {
				t.Fatal(e)
			}
			if ix.ProgramID() != a.Program || !bytes.Equal(data, decode(r.Data)) {
				t.Fatal("program or instruction bytes differ")
			}
			accounts := ix.Accounts()
			if len(accounts) != len(r.Accounts) {
				t.Fatal("account count differs")
			}
			for i, m := range accounts {
				expected := r.Accounts[i]
				if m.PublicKey != key(expected.Address) || m.IsSigner != (expected.Role&2 != 0) || m.IsWritable != (expected.Role&1 != 0) {
					t.Fatalf("account %d differs", i)
				}
			}
			blockhash, e := solana.HashFromBase58(r.Blockhash)
			if e != nil {
				t.Fatal(e)
			}
			// The two Solana libraries may order equal-role keys differently.
			// Compare the resolved instruction and lifetime, then verify the
			// exact message produced by Fased's own guarded builder.
			message := decode(r.Message)
			wire := make([]byte, 65+len(message))
			wire[0] = 1
			copy(wire[65:], message)
			sdkTx, e := solana.TransactionFromBytes(wire)
			if e != nil || sdkTx.Message.Header.NumRequiredSignatures != 1 || len(sdkTx.Message.AddressTableLookups) != 0 || len(sdkTx.Message.Instructions) != 1 || sdkTx.Message.RecentBlockhash != blockhash || sdkTx.Message.AccountKeys[0] != key(r.Owner) {
				t.Fatal("retail message envelope differs", e)
			}
			compiled := sdkTx.Message.Instructions[0]
			if sdkTx.Message.AccountKeys[compiled.ProgramIDIndex] != a.Program || !bytes.Equal(compiled.Data, data) || len(compiled.Accounts) != len(accounts) {
				t.Fatal("retail message instruction differs")
			}
			for i, index := range compiled.Accounts {
				if sdkTx.Message.AccountKeys[index] != accounts[i].PublicKey {
					t.Fatalf("retail message account %d differs", i)
				}
				writable, err := sdkTx.Message.IsWritable(accounts[i].PublicKey)
				if err != nil || writable != accounts[i].IsWritable || sdkTx.Message.IsSigner(accounts[i].PublicKey) != accounts[i].IsSigner {
					t.Fatalf("retail message account %d permissions differ: %v", i, err)
				}
			}
			goTx, e := solana.NewTransaction([]solana.Instruction{ix}, blockhash, solana.TransactionPayer(key(r.Owner)))
			if e != nil {
				t.Fatal(e)
			}
			goTx.Message.SetVersion(solana.MessageVersionV0)
			goMessage, e := goTx.Message.MarshalBinary()
			if e != nil {
				t.Fatal(e)
			}
			if e := verifyWENCampaignOwnerMessageV1(a, key(r.Owner), s, blockhash, 20, 100, goMessage); e != nil {
				t.Fatal(e)
			}
			goMessage[len(goMessage)-1] ^= 1
			if verifyWENCampaignOwnerMessageV1(a, key(r.Owner), s, blockhash, 20, 100, goMessage) == nil {
				t.Fatal("altered retail message accepted")
			}
		})
	}
}
