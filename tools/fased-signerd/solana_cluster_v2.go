package main

import "fased-signerd/internal/networkverify"

const (
	solanaMainnetGenesisHashV2 = networkverify.MainnetGenesisHash
	solanaDevnetGenesisHashV2  = networkverify.DevnetGenesisHash
)

func normalizeSolanaClusterV2(raw string) (string, error) {
	return networkverify.NormalizeCluster(raw)
}

func validateSolanaGenesisHashV2(cluster, genesisHash, rpcURL string) error {
	return networkverify.ValidateClusterGenesis(cluster, genesisHash, rpcURL)
}

// solanaRPCURLsForClusterV2 returns only endpoints whose live genesis hash
// matches the reviewed cluster. Unreachable fallbacks are omitted so they can
// never become an unverified write target later in the same operation.
func solanaRPCURLsForClusterV2(rpcURLs []string, cluster string) ([]string, error) {
	return networkverify.RPCURLsForCluster(rpcURLs, cluster, solanaWriteRPCRequestTimeout())
}
