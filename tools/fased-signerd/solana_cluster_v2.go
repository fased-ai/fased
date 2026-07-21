package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

const (
	solanaMainnetGenesisHashV2 = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
	solanaDevnetGenesisHashV2  = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)

func normalizeSolanaClusterV2(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value != raw {
		return "", errors.New("typed Vault bond cluster is invalid")
	}
	switch value {
	case "local", "devnet", "mainnet-beta":
		return value, nil
	default:
		return "", errors.New("typed Vault bond cluster must be local, devnet, or mainnet-beta")
	}
}

func validateSolanaGenesisHashV2(cluster, genesisHash, rpcURL string) error {
	cluster, err := normalizeSolanaClusterV2(cluster)
	if err != nil {
		return err
	}
	switch cluster {
	case "mainnet-beta":
		if genesisHash != solanaMainnetGenesisHashV2 {
			return errors.New("signer-owned RPC is not Solana mainnet-beta")
		}
	case "devnet":
		if genesisHash != solanaDevnetGenesisHashV2 {
			return errors.New("signer-owned RPC is not Solana devnet")
		}
	case "local":
		parsed, parseErr := url.Parse(rpcURL)
		if parseErr != nil {
			return errors.New("signer-owned local RPC URL is invalid")
		}
		host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
		ip := net.ParseIP(host)
		if !isSignerRPCLoopbackHostV2(host, ip) {
			return errors.New("typed local Vault bond execution requires a loopback signer-owned RPC")
		}
		if genesisHash == solanaMainnetGenesisHashV2 || genesisHash == solanaDevnetGenesisHashV2 || strings.TrimSpace(genesisHash) == "" {
			return errors.New("signer-owned local RPC has an invalid cluster genesis hash")
		}
	}
	return nil
}

// solanaRPCURLsForClusterV2 returns only endpoints whose live genesis hash
// matches the reviewed cluster. Unreachable fallbacks are omitted so they can
// never become an unverified write target later in the same operation.
func solanaRPCURLsForClusterV2(rpcURLs []string, cluster string) ([]string, error) {
	if _, err := normalizeSolanaClusterV2(cluster); err != nil {
		return nil, err
	}
	validated := make([]string, 0, len(rpcURLs))
	for _, rpcURL := range rpcURLs {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		genesis, err := client.GetGenesisHash(ctx)
		cancel()
		if err != nil {
			continue
		}
		if err := validateSolanaGenesisHashV2(cluster, genesis.String(), rpcURL); err != nil {
			return nil, fmt.Errorf("typed Vault bond cluster verification failed: %w", err)
		}
		validated = append(validated, rpcURL)
	}
	if len(validated) == 0 {
		return nil, errors.New("typed Vault bond cluster could not be verified by any signer-owned RPC")
	}
	return validated, nil
}
