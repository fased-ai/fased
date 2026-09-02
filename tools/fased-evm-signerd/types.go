package main

import (
	"errors"
	"strings"
	"time"
)

const (
	roleAgentService = "agent-service"
	roleStrategy     = "strategy"
)

type walletRecord struct {
	SchemaVersion uint8  `json:"schemaVersion"`
	Role          string `json:"role"`
	Generation    uint64 `json:"generation"`
	Address       string `json:"address"`
	CreatedAt     string `json:"createdAt"`
	RevokedAt     string `json:"revokedAt,omitempty"`
	Nonce         string `json:"nonce"`
	Ciphertext    string `json:"ciphertext"`
}

type publicWallet struct {
	Role       string `json:"role"`
	Generation uint64 `json:"generation"`
	Address    string `json:"address"`
	CreatedAt  string `json:"createdAt"`
	RevokedAt  string `json:"revokedAt,omitempty"`
	Active     bool   `json:"active"`
	Policy     policy `json:"policy"`
}

type policy struct {
	Mode                  string   `json:"mode"`
	CanSignTransactions   bool     `json:"canSignTransactions"`
	CanSignTypedData      bool     `json:"canSignTypedData"`
	CanTransferNative     bool     `json:"canTransferNative"`
	CanApproveTokens      bool     `json:"canApproveTokens"`
	CanTrade              bool     `json:"canTrade"`
	AllowedChainIDs       []uint64 `json:"allowedChainIds"`
	AllowedContracts      []string `json:"allowedContracts"`
	AllowedMethods        []string `json:"allowedMethods"`
	AllowedAssets         []string `json:"allowedAssets"`
	FixedDestinations     []string `json:"fixedDestinations"`
	MaxNativePerActionWei string   `json:"maxNativePerActionWei"`
	MaxNativePerDayWei    string   `json:"maxNativePerDayWei"`
}

func denyAllPolicy() policy {
	return policy{
		Mode:                  "deny-all",
		CanSignTransactions:   false,
		CanSignTypedData:      false,
		CanTransferNative:     false,
		CanApproveTokens:      false,
		CanTrade:              false,
		AllowedChainIDs:       []uint64{},
		AllowedContracts:      []string{},
		AllowedMethods:        []string{},
		AllowedAssets:         []string{},
		FixedDestinations:     []string{},
		MaxNativePerActionWei: "0",
		MaxNativePerDayWei:    "0",
	}
}

func validateRole(value string) error {
	if value != roleAgentService && value != roleStrategy {
		return errors.New("role must be agent-service or strategy")
	}
	return nil
}

func validateRecord(record walletRecord) error {
	if record.SchemaVersion != 1 || validateRole(record.Role) != nil || record.Generation == 0 {
		return errors.New("stored EVM wallet metadata is invalid")
	}
	if !isChecksumAddress(record.Address) {
		return errors.New("stored EVM wallet address is invalid")
	}
	created, err := time.Parse(time.RFC3339Nano, record.CreatedAt)
	if err != nil || created.UTC().Format(time.RFC3339Nano) != record.CreatedAt {
		return errors.New("stored EVM wallet creation time is invalid")
	}
	if record.RevokedAt != "" {
		revoked, err := time.Parse(time.RFC3339Nano, record.RevokedAt)
		if err != nil || revoked.UTC().Format(time.RFC3339Nano) != record.RevokedAt {
			return errors.New("stored EVM wallet revocation time is invalid")
		}
	}
	if strings.TrimSpace(record.Nonce) != record.Nonce || strings.TrimSpace(record.Ciphertext) != record.Ciphertext || record.Nonce == "" || record.Ciphertext == "" {
		return errors.New("stored EVM wallet ciphertext is invalid")
	}
	return nil
}

func (record walletRecord) public() publicWallet {
	return publicWallet{
		Role: record.Role, Generation: record.Generation, Address: record.Address,
		CreatedAt: record.CreatedAt, RevokedAt: record.RevokedAt, Active: record.RevokedAt == "",
		Policy: denyAllPolicy(),
	}
}
