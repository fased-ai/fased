package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type signerOwnedAccountSnapshotV2 struct {
	Slot      uint64
	Addresses []solana.PublicKey
	Accounts  []*rpc.Account
	Digest    string
}

func signerOwnedAccountSnapshotDigestV2(addresses []solana.PublicKey, accounts []*rpc.Account) (string, error) {
	if len(addresses) == 0 || len(addresses) != len(accounts) {
		return "", errors.New("signer-owned account snapshot is incomplete")
	}
	hash := sha256.New()
	for index, address := range addresses {
		account := accounts[index]
		hash.Write(address[:])
		if account == nil {
			// Missing accounts are meaningful for create-style instructions. Bind
			// the absence so execute rejects an account created after review.
			hash.Write([]byte{0})
			continue
		}
		hash.Write([]byte{1})
		if account.Data == nil {
			return "", fmt.Errorf("signer-owned account snapshot has invalid data for %s", address)
		}
		data := account.Data.GetBinary()
		hash.Write(account.Owner[:])
		var number [8]byte
		binary.LittleEndian.PutUint64(number[:], account.Lamports)
		hash.Write(number[:])
		if account.Executable {
			hash.Write([]byte{1})
		} else {
			hash.Write([]byte{0})
		}
		binary.LittleEndian.PutUint64(number[:], uint64(len(data)))
		hash.Write(number[:])
		hash.Write(data)
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}
func fetchSignerOwnedAccountSnapshotV2(rpcURLs []string, cluster string, addresses []solana.PublicKey) (signerOwnedAccountSnapshotV2, error) {
	if len(addresses) == 0 || len(addresses) > 16 {
		return signerOwnedAccountSnapshotV2{}, errors.New("Signer-owned account snapshot requires one to sixteen exact accounts")
	}
	verified, err := solanaRPCURLsForClusterV2(rpcURLs, cluster)
	if err != nil {
		return signerOwnedAccountSnapshotV2{}, err
	}
	for _, rpcURL := range verified {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetMultipleAccountsWithOpts(ctx, addresses, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentConfirmed})
		cancel()
		if requestErr != nil || result == nil || len(result.Value) != len(addresses) {
			if requestErr == nil {
				requestErr = errors.New("signer-owned account snapshot RPC response length mismatch")
			}
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		digest, digestErr := signerOwnedAccountSnapshotDigestV2(addresses, result.Value)
		if digestErr != nil {
			return signerOwnedAccountSnapshotV2{}, digestErr
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return signerOwnedAccountSnapshotV2{Slot: result.Context.Slot, Addresses: append([]solana.PublicKey(nil), addresses...), Accounts: result.Value, Digest: digest}, nil
	}
	return signerOwnedAccountSnapshotV2{}, errors.New("Signer-owned account signer-owned account snapshot failed")
}
