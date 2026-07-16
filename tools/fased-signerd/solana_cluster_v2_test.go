package main

import (
	"strings"
	"testing"
)

func TestSignerV2VaultBondClusterGenesisFailsClosed(t *testing.T) {
	tests := []struct {
		name, cluster, genesis, rpcURL, want string
	}{
		{name: "mainnet exact", cluster: "mainnet-beta", genesis: solanaMainnetGenesisHashV2, rpcURL: "https://rpc.example.com"},
		{name: "devnet exact", cluster: "devnet", genesis: solanaDevnetGenesisHashV2, rpcURL: "https://rpc.example.com"},
		{name: "wrong mainnet", cluster: "mainnet-beta", genesis: solanaDevnetGenesisHashV2, rpcURL: "https://rpc.example.com", want: "not Solana mainnet-beta"},
		{name: "wrong devnet", cluster: "devnet", genesis: solanaMainnetGenesisHashV2, rpcURL: "https://rpc.example.com", want: "not Solana devnet"},
		{name: "local external", cluster: "local", genesis: "LocalGenesis1111111111111111111111111111111", rpcURL: "https://rpc.example.com", want: "loopback"},
		{name: "local public genesis", cluster: "local", genesis: solanaDevnetGenesisHashV2, rpcURL: "http://127.0.0.1:8899", want: "invalid cluster genesis"},
		{name: "local exact", cluster: "local", genesis: "LocalGenesis1111111111111111111111111111111", rpcURL: "http://127.0.0.1:8899"},
		{name: "unknown cluster", cluster: "testnet", genesis: "anything", rpcURL: "https://rpc.example.com", want: "must be local, devnet, or mainnet-beta"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateSolanaGenesisHashV2(test.cluster, test.genesis, test.rpcURL)
			if test.want == "" && err != nil {
				t.Fatalf("expected cluster validation success, got %v", err)
			}
			if test.want != "" && (err == nil || !strings.Contains(err.Error(), test.want)) {
				t.Fatalf("expected %q, got %v", test.want, err)
			}
		})
	}
}
