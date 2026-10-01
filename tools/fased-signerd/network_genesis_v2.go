package main

import (
	"context"
	"errors"
)

func signerRPCGenesisHashV2(rpcURL string) (string, error) {
	client := newSignerOwnedSolanaRPCClientV2(rpcURL)
	ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
	genesis, err := client.GetGenesisHash(ctx)
	cancel()
	if err != nil {
		return "", errors.New("signer-owned Solana RPC genesis verification failed")
	}
	return genesis.String(), nil
}
