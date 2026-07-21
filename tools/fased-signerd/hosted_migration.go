package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"

	solana "github.com/gagliardetto/solana-go"
)

const (
	maxHostedMigrationPolicyBytesV1           = 1 << 20
	maxHostedMigrationLegacyKeystoreBytesV1   = 64 << 10
	maxHostedMigrationLegacyPassphraseBytesV1 = maxSignerImportBytesV2
	hostedMigrationSchemaVersionV1            = 1
)

type hostedMigrationPolicyInputV1 struct {
	Role       string                         `json:"role"`
	Operations []string                       `json:"operations"`
	Programs   []string                       `json:"programs"`
	Assets     []hostedMigrationPolicyAssetV1 `json:"assets"`
}

type hostedMigrationPolicyAssetV1 struct {
	Asset        string   `json:"asset"`
	Destinations []string `json:"destinations"`
	MaxPerTx     string   `json:"maxPerTx"`
	MaxDaily     string   `json:"maxDaily"`
}

type hostedMigrationWalletInputV1 struct {
	WalletID          string                        `json:"walletId"`
	ExpectedPublicKey string                        `json:"expectedPublicKey"`
	KeystorePath      string                        `json:"keystorePath"`
	PassphrasePath    string                        `json:"passphrasePath"`
	Policy            *hostedMigrationPolicyInputV1 `json:"policy,omitempty"`
	BaselineRole      string                        `json:"baselineRole,omitempty"`
	PrimaryRPCURL     string                        `json:"primaryRpcUrl,omitempty"`
}

type hostedMigrationPolicyFileV1 struct {
	SchemaVersion int                            `json:"schemaVersion"`
	Wallets       []hostedMigrationWalletInputV1 `json:"wallets"`
}

type hostedMigrationWalletV1 struct {
	WalletID          string
	ExpectedPublicKey string
	KeystorePath      string
	PassphrasePath    string
	Policy            signerPolicyV2
	Baseline          *signerRoleBaselineRequestV1
	PrimaryRPCURL     string
}

type hostedMigrationMarkerV1 struct {
	SchemaVersion int    `json:"schemaVersion"`
	PolicySHA256  string `json:"policySha256"`
}

type hostedMigrationConfigV1 struct {
	Phase            string
	ControlSocket    string
	PolicyFile       string
	AppHome          string
	LegacySignerHome string
	StateDirectory   string
	MarkerFile       string
}

type hostedMigrationOwnerV1 struct {
	UID uint32
	GID uint32
}

func runSignerAdminHostedMigrationV1(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("fased-signerd admin migration hosted-v1", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var cfg hostedMigrationConfigV1
	fs.StringVar(&cfg.Phase, "phase", "", "prepare or commit the one-time hosted migration")
	fs.StringVar(&cfg.ControlSocket, "control-socket", "", "absolute signer control socket path")
	fs.StringVar(&cfg.PolicyFile, "policy-file", "", "absolute root-owned migration policy path")
	fs.StringVar(&cfg.AppHome, "app-home", "", "absolute hosted application home")
	fs.StringVar(&cfg.LegacySignerHome, "legacy-signer-home", "", "absolute legacy signer home")
	fs.StringVar(&cfg.StateDirectory, "state-dir", "", "absolute signer-owned state directory")
	fs.StringVar(&cfg.MarkerFile, "marker-file", "", "absolute root-owned transaction marker")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return errors.New("hosted signer migration must run as root")
	}
	return runHostedSignerMigrationV1(cfg, stdout)
}

func runHostedSignerMigrationV1(cfg hostedMigrationConfigV1, stdout io.Writer) error {
	if cfg.Phase != "prepare" && cfg.Phase != "commit" {
		return errors.New("--phase must be prepare or commit")
	}
	for label, value := range map[string]string{
		"--control-socket":     cfg.ControlSocket,
		"--policy-file":        cfg.PolicyFile,
		"--app-home":           cfg.AppHome,
		"--legacy-signer-home": cfg.LegacySignerHome,
		"--state-dir":          cfg.StateDirectory,
		"--marker-file":        cfg.MarkerFile,
	} {
		if err := requireHostedMigrationAbsoluteCleanPathV1(value, label); err != nil {
			return err
		}
	}

	appHomeInfo, err := requireHostedMigrationDirectoryV1(cfg.AppHome, "hosted application home")
	if err != nil {
		return err
	}
	legacyHomeInfo, legacyHomeExists, err := optionalHostedMigrationDirectoryV1(cfg.LegacySignerHome, "legacy signer home")
	if err != nil {
		return err
	}
	stateInfo, err := requireHostedMigrationDirectoryV1(cfg.StateDirectory, "signer state directory")
	if err != nil {
		return err
	}
	stateOwner, err := hostedMigrationFileOwnerV1(stateInfo)
	if err != nil {
		return err
	}
	if stateInfo.Mode().Perm()&0o077 != 0 {
		return errors.New("signer state directory must not be accessible by group or others")
	}
	socketInfo, err := requireSignerAdminControlSocket(cfg.ControlSocket)
	if err != nil {
		return err
	}
	if socketInfo.ownerUID < 0 || uint32(socketInfo.ownerUID) != stateOwner.UID {
		return errors.New("signer control socket and state directory must have the same signer owner")
	}
	if err := requireHostedMigrationMarkerParentV1(cfg.MarkerFile); err != nil {
		return err
	}

	rawPolicy, err := readHostedMigrationRootFileV1(
		cfg.PolicyFile,
		maxHostedMigrationPolicyBytesV1,
		0o600,
		0,
		"migration policy",
	)
	if err != nil {
		return err
	}
	policyDigest := sha256.Sum256(rawPolicy)
	policyDigestLabel := "sha256:" + hex.EncodeToString(policyDigest[:])
	wallets, err := parseHostedMigrationPolicyV1(rawPolicy)
	zeroBytes(rawPolicy)
	if err != nil {
		return err
	}

	allowedRoots := []string{
		filepath.Join(cfg.AppHome, ".fased", "wallet"),
		filepath.Join(cfg.LegacySignerHome, ".fased", "wallet"),
	}
	appOwner, err := hostedMigrationFileOwnerV1(appHomeInfo)
	if err != nil {
		return err
	}
	allowedUIDs := map[uint32]bool{
		0:              true,
		stateOwner.UID: true,
		appOwner.UID:   true,
	}
	if legacyHomeExists {
		legacyOwner, err := hostedMigrationFileOwnerV1(legacyHomeInfo)
		if err != nil {
			return err
		}
		allowedUIDs[legacyOwner.UID] = true
	}
	for _, wallet := range wallets {
		if _, err := hostedMigrationAllowedRootV1(wallet.KeystorePath, allowedRoots); err != nil {
			return fmt.Errorf("invalid legacy keystore path for %s: %w", wallet.WalletID, err)
		}
		if _, err := hostedMigrationAllowedRootV1(wallet.PassphrasePath, allowedRoots); err != nil {
			return fmt.Errorf("invalid legacy passphrase path for %s: %w", wallet.WalletID, err)
		}
	}
	if err := requireHostedMigrationLegacyKeystoreCoverageV1(allowedRoots, wallets); err != nil {
		return err
	}

	marker, markerExists, err := readHostedMigrationMarkerV1(cfg.MarkerFile, 0)
	if err != nil {
		return err
	}
	if markerExists && marker.PolicySHA256 != policyDigestLabel {
		return errors.New("hosted signer migration policy changed after the transaction was prepared")
	}
	if cfg.Phase == "commit" && !markerExists {
		return errors.New("hosted signer migration has no durable prepared transaction marker")
	}

	verified := make([]signerWalletPolicyResultV2, 0, len(wallets))
	networkConfigured := make([]bool, 0, len(wallets))
	for _, wallet := range wallets {
		result, exists, err := readAndVerifyHostedMigrationWalletV1(cfg.ControlSocket, wallet)
		if err != nil {
			return err
		}
		if !exists {
			if cfg.Phase == "commit" {
				return fmt.Errorf("signer wallet %s is missing during migration commit", wallet.WalletID)
			}
			result, err = importHostedMigrationWalletV1(
				cfg,
				wallet,
				allowedRoots,
				allowedUIDs,
				stateOwner,
			)
			if err != nil {
				return err
			}
		}
		verified = append(verified, result)
		configured, err := configureHostedMigrationNetworkV1(cfg.ControlSocket, wallet)
		if err != nil {
			return err
		}
		networkConfigured = append(networkConfigured, configured)
	}
	if err := verifyHostedMigrationHealthV1(cfg.ControlSocket, verified); err != nil {
		return err
	}

	if cfg.Phase == "prepare" {
		if !markerExists {
			if err := writeHostedMigrationMarkerV1(cfg.MarkerFile, hostedMigrationMarkerV1{
				SchemaVersion: hostedMigrationSchemaVersionV1,
				PolicySHA256:  policyDigestLabel,
			}); err != nil {
				return err
			}
		}
		for index, wallet := range wallets {
			if _, err := fmt.Fprintf(
				stdout,
				"%s: %s policy=%s network=%s legacy=verified-pending-commit\n",
				wallet.WalletID,
				wallet.ExpectedPublicKey,
				verified[index].Policy.Hash,
				map[bool]string{true: "preserved", false: "setup-pending"}[networkConfigured[index]],
			); err != nil {
				return errors.New("write hosted signer migration result")
			}
		}
		return nil
	}

	sourceLimits := make(map[string]int64, len(wallets)*2)
	for _, wallet := range wallets {
		for source, maxBytes := range map[string]int64{
			wallet.KeystorePath:   maxHostedMigrationLegacyKeystoreBytesV1,
			wallet.PassphrasePath: maxHostedMigrationLegacyPassphraseBytesV1,
		} {
			if previous, exists := sourceLimits[source]; !exists || maxBytes < previous {
				sourceLimits[source] = maxBytes
			}
		}
	}
	sources := make([]string, 0, len(sourceLimits))
	for source := range sourceLimits {
		sources = append(sources, source)
	}
	sort.Strings(sources)
	for _, source := range sources {
		if _, err := quarantineHostedMigrationFileV1(
			source,
			allowedRoots,
			allowedUIDs,
			hostedMigrationOwnerV1{UID: 0, GID: 0},
			sourceLimits[source],
		); err != nil {
			return err
		}
	}
	if err := os.Remove(cfg.MarkerFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("remove hosted signer migration transaction marker")
	}
	if err := syncHostedMigrationDirectoryV1(filepath.Dir(cfg.MarkerFile)); err != nil {
		return errors.New("sync hosted signer migration marker directory")
	}
	for index, wallet := range wallets {
		if _, err := fmt.Fprintf(
			stdout,
			"%s: %s policy=%s network=%s legacy=consumed\n",
			wallet.WalletID,
			wallet.ExpectedPublicKey,
			verified[index].Policy.Hash,
			map[bool]string{true: "preserved", false: "setup-pending"}[networkConfigured[index]],
		); err != nil {
			return errors.New("write hosted signer migration result")
		}
	}
	return nil
}

func parseHostedMigrationPolicyV1(raw []byte) ([]hostedMigrationWalletV1, error) {
	var input hostedMigrationPolicyFileV1
	if err := decodeSignerAdminStrictJSON(raw, &input); err != nil {
		return nil, errors.New("migration policy must be one strict JSON object")
	}
	if input.SchemaVersion != hostedMigrationSchemaVersionV1 || len(input.Wallets) == 0 {
		return nil, errors.New("migration policy must use schemaVersion 1 and a non-empty wallets array")
	}
	wallets := make([]hostedMigrationWalletV1, 0, len(input.Wallets))
	seenWallets := map[string]bool{}
	for _, candidate := range input.Wallets {
		walletID, err := validateSignerAdminWalletID(candidate.WalletID)
		if err != nil {
			return nil, fmt.Errorf("invalid migration wallet ID: %w", err)
		}
		if seenWallets[walletID] {
			return nil, fmt.Errorf("migration policy contains duplicate wallet ID %s", walletID)
		}
		seenWallets[walletID] = true
		publicKey := strings.TrimSpace(candidate.ExpectedPublicKey)
		parsedPublicKey, err := solana.PublicKeyFromBase58(publicKey)
		if err != nil || parsedPublicKey.String() != publicKey {
			return nil, fmt.Errorf("expectedPublicKey is invalid for %s", walletID)
		}
		if err := requireHostedMigrationAbsoluteCleanPathV1(candidate.KeystorePath, "keystorePath"); err != nil {
			return nil, fmt.Errorf("invalid migration wallet %s: %w", walletID, err)
		}
		if err := requireHostedMigrationAbsoluteCleanPathV1(candidate.PassphrasePath, "passphrasePath"); err != nil {
			return nil, fmt.Errorf("invalid migration wallet %s: %w", walletID, err)
		}
		if candidate.KeystorePath == candidate.PassphrasePath {
			return nil, fmt.Errorf("migration wallet %s must use distinct keystore and passphrase files", walletID)
		}
		baselineRole := strings.TrimSpace(candidate.BaselineRole)
		if (candidate.Policy == nil) == (baselineRole == "") {
			return nil, fmt.Errorf("migration wallet %s must select exactly one explicit policy or signer-owned role baseline", walletID)
		}
		var policy signerPolicyV2
		var baseline *signerRoleBaselineRequestV1
		if baselineRole != "" {
			request, baselineErr := normalizeRoleBaselineRequestV1(signerRoleBaselineRequestV1{
				Version: signerRoleBaselineVersionV1,
				Role:    baselineRole,
			})
			if baselineErr != nil {
				return nil, fmt.Errorf("invalid migration role baseline for %s: %w", walletID, baselineErr)
			}
			policy, baselineErr = compileSignerRoleBaselineV1(
				walletID,
				publicKey,
				request,
				signerRoleBaselineRuntimeFromEnvV1(),
			)
			if baselineErr == nil {
				baseline = &request
			}
			if baselineErr != nil {
				return nil, fmt.Errorf("compile migration role baseline for %s: %w", walletID, baselineErr)
			}
		} else {
			if err := requireHostedMigrationUniqueStringsV1(candidate.Policy.Operations, "policy operations", walletID); err != nil {
				return nil, err
			}
			if err := requireHostedMigrationUniqueStringsV1(candidate.Policy.Programs, "policy programs", walletID); err != nil {
				return nil, err
			}
			if len(candidate.Policy.Assets) == 0 {
				return nil, fmt.Errorf("policy assets and positive caps must be explicit for %s", walletID)
			}
			assets := make([]signerPolicyAssetV2, 0, len(candidate.Policy.Assets))
			for _, asset := range candidate.Policy.Assets {
				if err := requireHostedMigrationUniqueStringsV1(asset.Destinations, "policy destinations", walletID); err != nil {
					return nil, err
				}
				assets = append(assets, signerPolicyAssetV2{
					Asset:        asset.Asset,
					Destinations: append([]string(nil), asset.Destinations...),
					MaxPerTx:     asset.MaxPerTx,
					MaxDaily:     asset.MaxDaily,
				})
			}
			policy, err = normalizeSignerPolicyV2(signerPolicyV2{
				WalletID:   walletID,
				Role:       candidate.Policy.Role,
				Version:    1,
				Operations: append([]string(nil), candidate.Policy.Operations...),
				Programs:   append([]string(nil), candidate.Policy.Programs...),
				Assets:     assets,
			})
			if err != nil {
				return nil, fmt.Errorf("invalid signer policy for %s: %w", walletID, err)
			}
			if len(policy.Operations) != len(candidate.Policy.Operations) || len(policy.Programs) != len(candidate.Policy.Programs) || len(policy.Assets) != len(candidate.Policy.Assets) {
				return nil, fmt.Errorf("signer policy for %s contains duplicate normalized entries", walletID)
			}
		}
		wallets = append(wallets, hostedMigrationWalletV1{
			WalletID:          walletID,
			ExpectedPublicKey: publicKey,
			KeystorePath:      candidate.KeystorePath,
			PassphrasePath:    candidate.PassphrasePath,
			Policy:            policy,
			Baseline:          baseline,
			PrimaryRPCURL:     strings.TrimSpace(candidate.PrimaryRPCURL),
		})
	}
	return wallets, nil
}

func configureHostedMigrationNetworkV1(controlSocket string, wallet hostedMigrationWalletV1) (bool, error) {
	if wallet.PrimaryRPCURL == "" {
		return false, nil
	}
	if _, err := callSignerAdmin(controlSocket, "v2.network.get", wallet.WalletID, nil); err == nil {
		return true, nil
	}
	expectedVersion := uint64(0)
	result, err := callSignerAdminSensitiveV2(controlSocket, "v2.network.put", wallet.WalletID, signerNetworkPutRequestV2{
		ExpectedVersion: &expectedVersion,
		PrimaryRPCURL:   wallet.PrimaryRPCURL,
	})
	if err != nil {
		return false, fmt.Errorf("verify preserved signer RPC for %s: %w", wallet.WalletID, err)
	}
	var summary signerNetworkSummaryV2
	if err := decodeSignerAdminStrictJSON(result, &summary); err != nil {
		return false, fmt.Errorf("verify preserved signer RPC metadata for %s", wallet.WalletID)
	}
	if err := validateSignerNetworkSummaryV2(summary, wallet.WalletID); err != nil {
		return false, fmt.Errorf("verify preserved signer RPC metadata for %s", wallet.WalletID)
	}
	return true, nil
}

func requireHostedMigrationUniqueStringsV1(values []string, label, walletID string) error {
	if len(values) == 0 {
		return fmt.Errorf("%s must be an explicit non-empty list for %s", label, walletID)
	}
	seen := map[string]bool{}
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || seen[value] {
			return fmt.Errorf("%s must not contain blanks or duplicates for %s", label, walletID)
		}
		seen[value] = true
	}
	return nil
}

func readAndVerifyHostedMigrationWalletV1(controlSocket string, expected hostedMigrationWalletV1) (signerWalletPolicyResultV2, bool, error) {
	walletRaw, err := callSignerAdmin(controlSocket, "v2.wallet.get", expected.WalletID, nil)
	if err != nil {
		if strings.Contains(err.Error(), "signer wallet not found") {
			return signerWalletPolicyResultV2{}, false, nil
		}
		return signerWalletPolicyResultV2{}, false, fmt.Errorf("query existing signer wallet %s: %w", expected.WalletID, err)
	}
	var wallet signerWalletRecordV2
	if err := decodeSignerAdminStrictJSON(walletRaw, &wallet); err != nil {
		return signerWalletPolicyResultV2{}, false, fmt.Errorf("signer returned an invalid wallet record for %s", expected.WalletID)
	}
	policyRaw, err := callSignerAdmin(controlSocket, "v2.policy.get", expected.WalletID, nil)
	if err != nil {
		return signerWalletPolicyResultV2{}, false, fmt.Errorf("query existing signer policy %s: %w", expected.WalletID, err)
	}
	var policy signerPolicyV2
	if err := decodeSignerAdminStrictJSON(policyRaw, &policy); err != nil {
		return signerWalletPolicyResultV2{}, false, fmt.Errorf("signer returned an invalid policy for %s", expected.WalletID)
	}
	result := signerWalletPolicyResultV2{Wallet: wallet, Policy: policy}
	if err := verifyHostedMigrationWalletResultV1(result, expected); err != nil {
		return signerWalletPolicyResultV2{}, false, err
	}
	return result, true, nil
}

func verifyHostedMigrationWalletResultV1(result signerWalletPolicyResultV2, expected hostedMigrationWalletV1) error {
	if result.Wallet.WalletID != expected.WalletID || result.Wallet.PublicKey != expected.ExpectedPublicKey {
		return fmt.Errorf("signer wallet address does not match migration policy for %s", expected.WalletID)
	}
	if result.Wallet.Secret != "" || result.Wallet.Nonce != "" {
		return fmt.Errorf("signer exposed encrypted wallet state for %s", expected.WalletID)
	}
	normalized, err := normalizeSignerPolicyV2(result.Policy)
	if err != nil || !reflect.DeepEqual(normalized, result.Policy) || !reflect.DeepEqual(result.Policy, expected.Policy) {
		return fmt.Errorf("signer wallet policy does not exactly match migration policy for %s", expected.WalletID)
	}
	return nil
}

func importHostedMigrationWalletV1(
	cfg hostedMigrationConfigV1,
	wallet hostedMigrationWalletV1,
	allowedRoots []string,
	allowedUIDs map[uint32]bool,
	signerOwner hostedMigrationOwnerV1,
) (signerWalletPolicyResultV2, error) {
	keystore, err := openHostedMigrationSourceV1(
		wallet.KeystorePath,
		allowedRoots,
		allowedUIDs,
		"legacy encrypted keystore",
		maxHostedMigrationLegacyKeystoreBytesV1,
	)
	if err != nil {
		return signerWalletPolicyResultV2{}, err
	}
	defer keystore.Close()
	passphrase, err := openHostedMigrationSourceV1(
		wallet.PassphrasePath,
		allowedRoots,
		allowedUIDs,
		"legacy passphrase",
		maxHostedMigrationLegacyPassphraseBytesV1,
	)
	if err != nil {
		return signerWalletPolicyResultV2{}, err
	}
	defer passphrase.Close()
	importDirectory, err := ensureHostedMigrationImportDirectoryV1(cfg.StateDirectory, signerOwner)
	if err != nil {
		return signerWalletPolicyResultV2{}, err
	}
	stagedKeystore, err := stageHostedMigrationSourceV1(
		importDirectory,
		"keystore",
		wallet.WalletID,
		keystore,
		signerOwner,
		maxHostedMigrationLegacyKeystoreBytesV1,
	)
	if err != nil {
		return signerWalletPolicyResultV2{}, err
	}
	stagedPassphrase, err := stageHostedMigrationSourceV1(
		importDirectory,
		"passphrase",
		wallet.WalletID,
		passphrase,
		signerOwner,
		maxHostedMigrationLegacyPassphraseBytesV1,
	)
	if err != nil {
		_ = cleanupHostedMigrationStageV1(stagedKeystore)
		return signerWalletPolicyResultV2{}, err
	}
	defer cleanupHostedMigrationStageV1(stagedKeystore)
	defer cleanupHostedMigrationStageV1(stagedPassphrase)

	body := signerWalletLegacyImportRequestV2{
		ExpectedVersion: 0,
		Policy:          wallet.Policy,
		Baseline:        wallet.Baseline,
		Path:            stagedKeystore,
		PassphrasePath:  stagedPassphrase,
	}
	resultRaw, callErr := callSignerAdminSensitiveV2(cfg.ControlSocket, "v2.wallet.importLegacy", wallet.WalletID, body)
	cleanupKeystoreErr := cleanupHostedMigrationStageV1(stagedKeystore)
	cleanupPassphraseErr := cleanupHostedMigrationStageV1(stagedPassphrase)
	if cleanupKeystoreErr != nil || cleanupPassphraseErr != nil {
		return signerWalletPolicyResultV2{}, errors.New("signer-owned legacy import staging cleanup failed; inspect the signer state directory before continuing")
	}
	if callErr != nil {
		// A lost response may follow a successful durable import. Query the exact
		// wallet and policy before reporting failure; a rerun always does the same.
		result, exists, verifyErr := readAndVerifyHostedMigrationWalletV1(cfg.ControlSocket, wallet)
		if verifyErr == nil && exists {
			return result, nil
		}
		return signerWalletPolicyResultV2{}, fmt.Errorf("native signer legacy import for %s was not acknowledged; query signer state before retrying: %w", wallet.WalletID, callErr)
	}
	var result signerWalletPolicyResultV2
	if err := decodeSignerAdminStrictJSON(resultRaw, &result); err != nil {
		return signerWalletPolicyResultV2{}, fmt.Errorf("signer returned an invalid migration result for %s", wallet.WalletID)
	}
	if err := verifyHostedMigrationWalletResultV1(result, wallet); err != nil {
		return signerWalletPolicyResultV2{}, err
	}
	return result, nil
}

func verifyHostedMigrationHealthV1(controlSocket string, wallets []signerWalletPolicyResultV2) error {
	raw, err := callSignerAdmin(controlSocket, "health", "", nil)
	if err != nil {
		return fmt.Errorf("query signer health after migration: %w", err)
	}
	var health signerHealthResultV2
	if err := decodeSignerAdminStrictJSON(raw, &health); err != nil {
		return errors.New("signer returned an invalid health result after migration")
	}
	protocol := health.Capabilities.Protocol
	if !health.Ready || protocol.Current != signerProtocolVersion || protocol.Min > signerProtocolVersion || protocol.Max < signerProtocolVersion {
		return errors.New("signer health did not acknowledge protocol v2 after migration")
	}
	for _, wallet := range wallets {
		acknowledged := false
		for _, policy := range health.Policies {
			if policy.WalletID == wallet.Wallet.WalletID && policy.Version == wallet.Policy.Version && policy.Hash == wallet.Policy.Hash {
				acknowledged = true
				break
			}
		}
		if !acknowledged {
			return fmt.Errorf("signer health did not acknowledge the exact policy for %s", wallet.Wallet.WalletID)
		}
	}
	return nil
}

func requireHostedMigrationAbsoluteCleanPathV1(value, label string) error {
	if strings.TrimSpace(value) == "" || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return fmt.Errorf("%s must be an absolute clean path", label)
	}
	return nil
}

func requireHostedMigrationDirectoryV1(path, label string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", label, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fmt.Errorf("%s must be a non-symlink directory", label)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != filepath.Clean(path) {
		return nil, fmt.Errorf("%s must not contain symlink path components", label)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return nil, fmt.Errorf("%s must not be group/world writable", label)
	}
	return info, nil
}

func optionalHostedMigrationDirectoryV1(path, label string) (os.FileInfo, bool, error) {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	} else if err != nil {
		return nil, false, fmt.Errorf("inspect %s: %w", label, err)
	}
	info, err := requireHostedMigrationDirectoryV1(path, label)
	return info, err == nil, err
}

func hostedMigrationFileOwnerV1(info os.FileInfo) (hostedMigrationOwnerV1, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return hostedMigrationOwnerV1{}, errors.New("file ownership metadata is unavailable")
	}
	return hostedMigrationOwnerV1{UID: stat.Uid, GID: stat.Gid}, nil
}

func hostedMigrationLinkCountV1(info os.FileInfo) (uint64, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errors.New("file link metadata is unavailable")
	}
	return uint64(stat.Nlink), nil
}

func hostedMigrationAllowedRootV1(path string, allowedRoots []string) (string, error) {
	for _, root := range allowedRoots {
		relative, err := filepath.Rel(root, path)
		if err != nil || relative == "." || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		return root, nil
	}
	return "", errors.New("path is outside approved legacy wallet directories")
}

func requireHostedMigrationLegacyKeystoreCoverageV1(allowedRoots []string, wallets []hostedMigrationWalletV1) error {
	configured := make(map[string]bool, len(wallets))
	for _, wallet := range wallets {
		configured[wallet.KeystorePath] = true
	}
	for _, root := range allowedRoots {
		if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return errors.New("inspect approved legacy wallet directory")
		}
		if _, err := requireHostedMigrationDirectoryV1(root, "approved legacy wallet directory"); err != nil {
			return err
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			return errors.New("list approved legacy wallet directory")
		}
		for _, entry := range entries {
			matched, err := filepath.Match("keystore-*.enc", entry.Name())
			if err != nil {
				return errors.New("match legacy wallet keystore name")
			}
			path := filepath.Join(root, entry.Name())
			if matched && !configured[path] {
				return fmt.Errorf("legacy encrypted keystore is missing from the explicit migration policy: %s", path)
			}
		}
	}
	return nil
}

func verifyHostedMigrationSourceParentV1(path, root string) error {
	rootInfo, err := os.Lstat(root)
	if err != nil || rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return errors.New("approved legacy wallet directory must be a non-symlink directory")
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil || resolvedRoot != filepath.Clean(root) {
		return errors.New("approved legacy wallet directory must not contain symlink components")
	}
	parent := filepath.Dir(path)
	resolvedParent, err := filepath.EvalSymlinks(parent)
	if err != nil || resolvedParent != filepath.Clean(parent) {
		return errors.New("legacy wallet source parent must not contain symlink components")
	}
	if _, err := hostedMigrationAllowedRootV1(path, []string{resolvedRoot}); err != nil {
		return err
	}
	return nil
}

func openHostedMigrationSourceV1(path string, allowedRoots []string, allowedUIDs map[uint32]bool, label string, maxBytes int64) (*os.File, error) {
	root, err := hostedMigrationAllowedRootV1(path, allowedRoots)
	if err != nil {
		return nil, fmt.Errorf("%s is outside approved legacy wallet directories", label)
	}
	if err := verifyHostedMigrationSourceParentV1(path, root); err != nil {
		return nil, fmt.Errorf("invalid %s path: %w", label, err)
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", label, err)
	}
	if err := validateHostedMigrationSourceInfoV1(before, allowedUIDs, label, 1, maxBytes); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", label, err)
	}
	after, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("inspect opened %s: %w", label, err)
	}
	if !os.SameFile(before, after) {
		file.Close()
		return nil, fmt.Errorf("%s changed while opening", label)
	}
	if err := validateHostedMigrationSourceInfoV1(after, allowedUIDs, label, 1, maxBytes); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func validateHostedMigrationSourceInfoV1(info os.FileInfo, allowedUIDs map[uint32]bool, label string, links uint64, maxBytes int64) error {
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("%s must be a regular non-symlink file", label)
	}
	linkCount, err := hostedMigrationLinkCountV1(info)
	if err != nil || linkCount != links {
		return fmt.Errorf("%s must have exactly %d link(s)", label, links)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must not be accessible by group or others", label)
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return fmt.Errorf("%s has an invalid size", label)
	}
	owner, err := hostedMigrationFileOwnerV1(info)
	if err != nil || !allowedUIDs[owner.UID] {
		return fmt.Errorf("%s has an unexpected owner", label)
	}
	return nil
}

func ensureHostedMigrationImportDirectoryV1(stateDirectory string, signerOwner hostedMigrationOwnerV1) (string, error) {
	directory := filepath.Join(stateDirectory, "import")
	if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", errors.New("create signer-owned legacy import directory")
	}
	before, err := os.Lstat(directory)
	if err != nil || before.Mode()&os.ModeSymlink != 0 || !before.IsDir() {
		return "", errors.New("signer-owned legacy import directory is unsafe")
	}
	beforeOwner, err := hostedMigrationFileOwnerV1(before)
	if err != nil || before.Mode().Perm() != 0o700 || (beforeOwner != signerOwner && beforeOwner.UID != 0) {
		return "", errors.New("signer-owned legacy import directory has an unexpected owner")
	}
	handle, err := os.Open(directory)
	if err != nil {
		return "", errors.New("open signer-owned legacy import directory")
	}
	defer handle.Close()
	opened, err := handle.Stat()
	if err != nil || !os.SameFile(before, opened) || !opened.IsDir() {
		return "", errors.New("signer-owned legacy import directory changed while opening")
	}
	if err := handle.Chown(int(signerOwner.UID), int(signerOwner.GID)); err != nil {
		return "", errors.New("set signer-owned legacy import directory owner")
	}
	if err := handle.Chmod(0o700); err != nil {
		return "", errors.New("lock signer-owned legacy import directory")
	}
	if err := handle.Sync(); err != nil {
		return "", errors.New("sync signer-owned legacy import directory")
	}
	info, err := handle.Stat()
	current, currentErr := os.Lstat(directory)
	if err != nil || currentErr != nil || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(info, current) || !info.IsDir() || info.Mode().Perm() != 0o700 {
		return "", errors.New("signer-owned legacy import directory is unsafe")
	}
	owner, err := hostedMigrationFileOwnerV1(info)
	if err != nil || owner != signerOwner {
		return "", errors.New("signer-owned legacy import directory has an unexpected owner")
	}
	return directory, nil
}

func stageHostedMigrationSourceV1(directory, kind, walletID string, source *os.File, signerOwner hostedMigrationOwnerV1, maxBytes int64) (string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return "", errors.New("generate signer migration staging filename")
		}
		name := fmt.Sprintf(".%s-%s-%s", kind, walletID, hex.EncodeToString(random))
		zeroBytes(random)
		path := filepath.Join(directory, name)
		destination, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", errors.New("create signer-owned legacy import file")
		}
		buffer := make([]byte, 32<<10)
		copied, copyErr := io.CopyBuffer(destination, io.LimitReader(source, maxBytes+1), buffer)
		zeroBytes(buffer)
		if copyErr == nil && copied > maxBytes {
			copyErr = errors.New("legacy import source exceeded its size limit while staging")
		}
		if copyErr == nil {
			copyErr = destination.Chown(int(signerOwner.UID), int(signerOwner.GID))
		}
		if copyErr == nil {
			copyErr = destination.Chmod(0o600)
		}
		if copyErr == nil {
			copyErr = destination.Sync()
		}
		closeErr := destination.Close()
		if copyErr == nil {
			copyErr = closeErr
		}
		if copyErr == nil {
			copyErr = syncHostedMigrationDirectoryV1(directory)
		}
		if copyErr != nil {
			_ = os.Remove(path)
			return "", errors.New("copy signer-owned legacy import file")
		}
		return path, nil
	}
	return "", errors.New("allocate signer-owned legacy import file")
}

func cleanupHostedMigrationStageV1(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncHostedMigrationDirectoryV1(filepath.Dir(path))
}

func readHostedMigrationRootFileV1(path string, maxBytes int64, exactMode os.FileMode, expectedUID uint32, label string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", label, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != exactMode {
		return nil, fmt.Errorf("%s must be a non-symlink regular file with mode %04o", label, exactMode)
	}
	owner, err := hostedMigrationFileOwnerV1(info)
	if err != nil || owner.UID != expectedUID {
		return nil, fmt.Errorf("%s has an unexpected owner", label)
	}
	links, err := hostedMigrationLinkCountV1(info)
	if err != nil || links != 1 {
		return nil, fmt.Errorf("%s must have exactly one link", label)
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return nil, fmt.Errorf("%s has an invalid size", label)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", label, err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, fmt.Errorf("%s changed while opening", label)
	}
	if opened.Mode()&os.ModeSymlink != 0 || !opened.Mode().IsRegular() || opened.Mode().Perm() != exactMode {
		return nil, fmt.Errorf("%s changed permissions or type while opening", label)
	}
	openedOwner, err := hostedMigrationFileOwnerV1(opened)
	if err != nil || openedOwner.UID != expectedUID {
		return nil, fmt.Errorf("%s changed owner while opening", label)
	}
	openedLinks, err := hostedMigrationLinkCountV1(opened)
	if err != nil || openedLinks != 1 || opened.Size() <= 0 || opened.Size() > maxBytes {
		return nil, fmt.Errorf("%s changed links or size while opening", label)
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil || int64(len(raw)) > maxBytes {
		zeroBytes(raw)
		return nil, fmt.Errorf("read %s within size limit", label)
	}
	return raw, nil
}

func requireHostedMigrationMarkerParentV1(markerFile string) error {
	parent := filepath.Dir(markerFile)
	info, err := requireHostedMigrationDirectoryV1(parent, "migration marker directory")
	if err != nil {
		return err
	}
	owner, err := hostedMigrationFileOwnerV1(info)
	if err != nil || owner.UID != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("migration marker directory must be root-owned and inaccessible to group or others")
	}
	return nil
}

func readHostedMigrationMarkerV1(path string, expectedUID uint32) (hostedMigrationMarkerV1, bool, error) {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return hostedMigrationMarkerV1{}, false, nil
	} else if err != nil {
		return hostedMigrationMarkerV1{}, false, errors.New("inspect hosted signer migration transaction marker")
	}
	raw, err := readHostedMigrationRootFileV1(path, 4096, 0o600, expectedUID, "migration transaction marker")
	if err != nil {
		return hostedMigrationMarkerV1{}, false, err
	}
	defer zeroBytes(raw)
	var marker hostedMigrationMarkerV1
	if err := decodeSignerAdminStrictJSON(raw, &marker); err != nil || marker.SchemaVersion != hostedMigrationSchemaVersionV1 || !strings.HasPrefix(marker.PolicySHA256, "sha256:") || len(marker.PolicySHA256) != len("sha256:")+64 {
		return hostedMigrationMarkerV1{}, false, errors.New("hosted signer migration transaction marker is invalid")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(marker.PolicySHA256, "sha256:")); err != nil {
		return hostedMigrationMarkerV1{}, false, errors.New("hosted signer migration transaction marker digest is invalid")
	}
	return marker, true, nil
}

func writeHostedMigrationMarkerV1(path string, marker hostedMigrationMarkerV1) error {
	encoded, err := json.Marshal(marker)
	if err != nil {
		return errors.New("encode hosted signer migration transaction marker")
	}
	encoded = append(encoded, '\n')
	defer zeroBytes(encoded)
	parent := filepath.Dir(path)
	for attempt := 0; attempt < 8; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return errors.New("generate hosted signer migration marker filename")
		}
		temporary := filepath.Join(parent, ".signer-migration-"+hex.EncodeToString(random)+".tmp")
		zeroBytes(random)
		file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return errors.New("create hosted signer migration transaction marker")
		}
		writeErr := writeSignerAdminAll(file, encoded)
		if writeErr == nil {
			writeErr = file.Sync()
		}
		closeErr := file.Close()
		if writeErr == nil {
			writeErr = closeErr
		}
		if writeErr == nil {
			if _, err := os.Lstat(path); err == nil {
				writeErr = errors.New("hosted signer migration transaction marker appeared concurrently")
			} else if !errors.Is(err, os.ErrNotExist) {
				writeErr = err
			}
		}
		if writeErr == nil {
			writeErr = os.Rename(temporary, path)
		}
		if writeErr == nil {
			writeErr = syncHostedMigrationDirectoryV1(parent)
		}
		if writeErr != nil {
			_ = os.Remove(temporary)
			return errors.New("persist hosted signer migration transaction marker")
		}
		return nil
	}
	return errors.New("allocate hosted signer migration transaction marker")
}

func quarantineHostedMigrationFileV1(path string, allowedRoots []string, allowedUIDs map[uint32]bool, quarantineOwner hostedMigrationOwnerV1, maxBytes int64) (string, error) {
	destination := path + ".migrated-v2"
	root, err := hostedMigrationAllowedRootV1(path, allowedRoots)
	if err != nil {
		return "", errors.New("legacy wallet material is outside approved directories")
	}
	if err := verifyHostedMigrationSourceParentV1(path, root); err != nil {
		return "", err
	}
	sourceInfo, sourceErr := os.Lstat(path)
	if sourceErr != nil && !errors.Is(sourceErr, os.ErrNotExist) {
		return "", errors.New("inspect legacy wallet material before quarantine")
	}
	destinationInfo, destinationExists, err := verifiedHostedMigrationQuarantineV1(destination, quarantineOwner, true, maxBytes)
	if err != nil {
		return "", err
	}
	if errors.Is(sourceErr, os.ErrNotExist) {
		if !destinationExists {
			// Commit is idempotent after a previously verified source was consumed.
			return destination, nil
		}
		links, _ := hostedMigrationLinkCountV1(destinationInfo)
		if links != 1 {
			return "", errors.New("legacy wallet quarantine has an incomplete link state")
		}
		if err := os.Remove(destination); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", errors.New("remove committed legacy wallet transaction copy")
		}
		if err := syncHostedMigrationDirectoryV1(filepath.Dir(path)); err != nil {
			return "", errors.New("sync committed legacy wallet cleanup")
		}
		return destination, nil
	}
	if destinationExists {
		sourceLinks, _ := hostedMigrationLinkCountV1(sourceInfo)
		destinationLinks, _ := hostedMigrationLinkCountV1(destinationInfo)
		if !os.SameFile(sourceInfo, destinationInfo) || sourceLinks != 2 || destinationLinks != 2 {
			return "", errors.New("legacy wallet quarantine destination already exists")
		}
		if err := os.Remove(path); err != nil {
			return "", errors.New("remove legacy wallet source after durable quarantine link")
		}
		if err := syncHostedMigrationDirectoryV1(filepath.Dir(path)); err != nil {
			return "", errors.New("sync legacy wallet quarantine directory")
		}
		if err := os.Remove(destination); err != nil {
			return "", errors.New("remove committed legacy wallet transaction copy")
		}
		if err := syncHostedMigrationDirectoryV1(filepath.Dir(path)); err != nil {
			return "", errors.New("sync committed legacy wallet cleanup")
		}
		return destination, nil
	}

	file, err := openHostedMigrationSourceV1(
		path,
		allowedRoots,
		allowedUIDs,
		"legacy wallet material",
		maxBytes,
	)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if err := file.Chown(int(quarantineOwner.UID), int(quarantineOwner.GID)); err != nil {
		return "", errors.New("take ownership of legacy wallet material before quarantine")
	}
	if err := file.Chmod(0); err != nil {
		return "", errors.New("lock legacy wallet material before quarantine")
	}
	if err := file.Sync(); err != nil {
		return "", errors.New("sync locked legacy wallet material")
	}
	lockedInfo, err := file.Stat()
	if err != nil {
		return "", errors.New("inspect locked legacy wallet material")
	}
	currentInfo, err := os.Lstat(path)
	if err != nil || !os.SameFile(lockedInfo, currentInfo) {
		return "", errors.New("legacy wallet material changed during quarantine")
	}
	if err := linkHostedMigrationDescriptorV1(file, destination); err != nil {
		return "", errors.New("create durable legacy wallet quarantine link")
	}
	linkedInfo, linkedExists, err := verifiedHostedMigrationQuarantineV1(destination, quarantineOwner, true, maxBytes)
	if err != nil || !linkedExists || !os.SameFile(lockedInfo, linkedInfo) {
		return "", errors.New("verify durable legacy wallet quarantine link")
	}
	if err := syncHostedMigrationDirectoryV1(filepath.Dir(path)); err != nil {
		return "", errors.New("sync legacy wallet quarantine link")
	}
	if err := os.Remove(path); err != nil {
		return "", errors.New("remove legacy wallet source after quarantine")
	}
	if err := syncHostedMigrationDirectoryV1(filepath.Dir(path)); err != nil {
		return "", errors.New("sync legacy wallet quarantine directory")
	}
	if err := os.Remove(destination); err != nil {
		return "", errors.New("remove committed legacy wallet transaction copy")
	}
	if err := syncHostedMigrationDirectoryV1(filepath.Dir(path)); err != nil {
		return "", errors.New("sync committed legacy wallet cleanup")
	}
	return destination, nil
}

func verifiedHostedMigrationQuarantineV1(path string, owner hostedMigrationOwnerV1, allowTwoLinks bool, maxBytes int64) (os.FileInfo, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errors.New("inspect legacy wallet quarantine")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != 0 {
		return nil, false, errors.New("legacy wallet quarantine must be a locked regular file")
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return nil, false, errors.New("legacy wallet quarantine has an invalid size")
	}
	actualOwner, err := hostedMigrationFileOwnerV1(info)
	if err != nil || actualOwner != owner {
		return nil, false, errors.New("legacy wallet quarantine has an unexpected owner")
	}
	links, err := hostedMigrationLinkCountV1(info)
	if err != nil || (links != 1 && (!allowTwoLinks || links != 2)) {
		return nil, false, errors.New("legacy wallet quarantine has an invalid link count")
	}
	return info, true, nil
}

func syncHostedMigrationDirectoryV1(directory string) error {
	handle, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}
