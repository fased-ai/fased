// Package policy owns the canonical signer policy representation and the pure
// validation rules used when that policy is created or tightened.
package policy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

const FederationBondProgramDomain = "domain:fased:federation-bond-challenge-v1"

type Asset struct {
	Asset                string   `json:"asset"`
	Destinations         []string `json:"destinations"`
	MaxPerTx             string   `json:"maxPerTx"`
	MaxDaily             string   `json:"maxDaily"`
	ReviewedDestinations bool     `json:"reviewedDestinations,omitempty"`
	TypedSATDestinations bool     `json:"typedSatDestinations,omitempty"`
}

type Policy struct {
	WalletID         string   `json:"walletId"`
	Role             string   `json:"role"`
	Version          uint64   `json:"version"`
	BaselineVersion  uint64   `json:"baselineVersion,omitempty"`
	Operations       []string `json:"operations"`
	Programs         []string `json:"programs"`
	TypedSATPrograms bool     `json:"typedSatPrograms,omitempty"`
	Assets           []Asset  `json:"assets"`
	Hash             string   `json:"hash"`
}

func NormalizeWalletID(walletID string) string {
	value := strings.TrimSpace(strings.ToLower(walletID))
	if value == "" {
		return "default"
	}
	var normalized strings.Builder
	lastUnderscore := false
	for _, character := range value {
		alphaNumeric := (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
		if alphaNumeric {
			normalized.WriteRune(character)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			normalized.WriteRune('_')
			lastUnderscore = true
		}
	}
	result := strings.Trim(normalized.String(), "_")
	if result == "" {
		return "default"
	}
	return result
}

func Normalize(input Policy) (Policy, error) {
	policy := Policy{
		WalletID:         NormalizeWalletID(input.WalletID),
		Version:          input.Version,
		BaselineVersion:  input.BaselineVersion,
		Role:             strings.TrimSpace(strings.ToLower(input.Role)),
		TypedSATPrograms: input.TypedSATPrograms,
		Assets:           make([]Asset, 0, len(input.Assets)),
	}
	if strings.TrimSpace(input.WalletID) == "" {
		return Policy{}, errors.New("walletId is required")
	}
	switch policy.Role {
	case "agent", "mining", "vault":
	default:
		return Policy{}, errors.New("policy role must be agent, mining, or vault")
	}
	var err error
	policy.Operations, err = normalizeSortedStrings(input.Operations, func(raw string) (string, error) {
		value := strings.TrimSpace(raw)
		if value == "" {
			return "", errors.New("policy operation cannot be empty")
		}
		return value, nil
	})
	if err != nil {
		return Policy{}, err
	}
	policy.Programs, err = normalizeSortedStrings(input.Programs, func(raw string) (string, error) {
		if strings.TrimSpace(raw) == FederationBondProgramDomain {
			return FederationBondProgramDomain, nil
		}
		return normalizePublicKey(raw, "policy program")
	})
	if err != nil {
		return Policy{}, err
	}

	seenAssets := map[string]bool{}
	for _, rawAsset := range input.Assets {
		asset := Asset{
			Asset:                strings.TrimSpace(rawAsset.Asset),
			ReviewedDestinations: rawAsset.ReviewedDestinations,
			TypedSATDestinations: rawAsset.TypedSATDestinations,
		}
		if asset.Asset == "solana:native" || asset.Asset == "sat:action" || asset.Asset == "sat:capital:lamports" || asset.Asset == "federation:bond-challenge" {
			// canonical as-is
		} else if strings.HasPrefix(asset.Asset, "solana:spl:") {
			mint, err := normalizePublicKey(strings.TrimPrefix(asset.Asset, "solana:spl:"), "policy asset mint")
			if err != nil {
				return Policy{}, err
			}
			asset.Asset = "solana:spl:" + mint
		} else if strings.HasPrefix(asset.Asset, "sat:mint:") {
			mint, err := normalizePublicKey(strings.TrimPrefix(asset.Asset, "sat:mint:"), "SAT policy asset mint")
			if err != nil {
				return Policy{}, err
			}
			asset.Asset = "sat:mint:" + mint
		} else {
			return Policy{}, fmt.Errorf("unsupported policy asset %q", asset.Asset)
		}
		if seenAssets[asset.Asset] {
			return Policy{}, fmt.Errorf("duplicate policy asset %s", asset.Asset)
		}
		seenAssets[asset.Asset] = true
		asset.Destinations, err = normalizeSortedStrings(rawAsset.Destinations, func(raw string) (string, error) {
			return normalizePublicKey(raw, "policy destination")
		})
		if err != nil {
			return Policy{}, err
		}
		maxPerTx, err := parsePositiveAmount(rawAsset.MaxPerTx, "policy maxPerTx")
		if err != nil {
			return Policy{}, err
		}
		maxDaily, err := parsePositiveAmount(rawAsset.MaxDaily, "policy maxDaily")
		if err != nil {
			return Policy{}, err
		}
		asset.MaxPerTx = maxPerTx.String()
		asset.MaxDaily = maxDaily.String()
		policy.Assets = append(policy.Assets, asset)
	}
	sort.Slice(policy.Assets, func(i, j int) bool { return policy.Assets[i].Asset < policy.Assets[j].Asset })

	policy.Hash = ""
	canonical, err := json.Marshal(policy)
	if err != nil {
		return Policy{}, err
	}
	hash := sha256.Sum256(canonical)
	policy.Hash = "sha256:" + hex.EncodeToString(hash[:])
	return policy, nil
}

func RequireTightening(current, candidate Policy) error {
	if current.WalletID != candidate.WalletID || current.Role != candidate.Role {
		return errors.New("application policy change cannot alter wallet identity or role")
	}
	if candidate.BaselineVersion != current.BaselineVersion || candidate.TypedSATPrograms != current.TypedSATPrograms {
		return errors.New("application policy change cannot alter signer-owned baseline authority")
	}
	if !stringSetSubset(candidate.Operations, current.Operations) {
		return errors.New("application policy change cannot add operations")
	}
	if !stringSetSubset(candidate.Programs, current.Programs) {
		return errors.New("application policy change cannot add programs")
	}
	currentAssets := make(map[string]Asset, len(current.Assets))
	for _, asset := range current.Assets {
		currentAssets[asset.Asset] = asset
	}
	for _, candidateAsset := range candidate.Assets {
		currentAsset, ok := currentAssets[candidateAsset.Asset]
		if !ok {
			return fmt.Errorf("application policy change cannot add asset %s", candidateAsset.Asset)
		}
		if !stringSetSubset(candidateAsset.Destinations, currentAsset.Destinations) {
			return fmt.Errorf("application policy change cannot add destinations for %s", candidateAsset.Asset)
		}
		if candidateAsset.ReviewedDestinations && !currentAsset.ReviewedDestinations {
			return fmt.Errorf("application policy change cannot add reviewed destinations for %s", candidateAsset.Asset)
		}
		if candidateAsset.TypedSATDestinations && !currentAsset.TypedSATDestinations {
			return fmt.Errorf("application policy change cannot add typed SAT destinations for %s", candidateAsset.Asset)
		}
		if !policyAmountAtMost(candidateAsset.MaxPerTx, currentAsset.MaxPerTx) {
			return fmt.Errorf("application policy change cannot raise per-transaction cap for %s", candidateAsset.Asset)
		}
		if !policyAmountAtMost(candidateAsset.MaxDaily, currentAsset.MaxDaily) {
			return fmt.Errorf("application policy change cannot raise daily cap for %s", candidateAsset.Asset)
		}
	}
	return nil
}

func normalizePublicKey(raw, field string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	key, err := solana.PublicKeyFromBase58(value)
	if err != nil {
		return "", fmt.Errorf("invalid %s", field)
	}
	return key.String(), nil
}

func parsePositiveAmount(raw, field string) (*big.Int, error) {
	value, ok := new(big.Int).SetString(strings.TrimSpace(raw), 10)
	if !ok || value.Sign() <= 0 {
		return nil, fmt.Errorf("%s must be a positive integer", field)
	}
	if value.BitLen() > 64 {
		return nil, fmt.Errorf("%s exceeds uint64", field)
	}
	return value, nil
}

func normalizeSortedStrings(values []string, normalize func(string) (string, error)) ([]string, error) {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		value, err := normalize(raw)
		if err != nil {
			return nil, err
		}
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out, nil
}

func stringSetSubset(candidate, current []string) bool {
	allowed := make(map[string]bool, len(current))
	for _, value := range current {
		allowed[value] = true
	}
	for _, value := range candidate {
		if !allowed[value] {
			return false
		}
	}
	return true
}

func policyAmountAtMost(candidate, current string) bool {
	candidateAmount, candidateOK := new(big.Int).SetString(candidate, 10)
	currentAmount, currentOK := new(big.Int).SetString(current, 10)
	return candidateOK && currentOK && candidateAmount.Sign() > 0 && candidateAmount.Cmp(currentAmount) <= 0
}
