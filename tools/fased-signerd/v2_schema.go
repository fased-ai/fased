package main

import (
	"encoding/json"
	"fmt"

	"fased-signerd/internal/migration"
	signerstore "fased-signerd/internal/store"
	bolt "go.etcd.io/bbolt"
)

const signerStateSchemaVersionV2 = migration.SignerStateSchemaVersion

var signerStateBucketsV2 = [][]byte{
	bucketSignerMetaV2,
	bucketSignerPoliciesV2,
	bucketSignerOperationsV2,
	bucketSignerOperationArchiveV2,
	bucketSignerUsageV2,
	bucketSignerWalletsV2,
	bucketSignerNetworksV2,
	bucketSignerWebAuthnCredentialsV2,
	bucketSignerWebAuthnChallengesV2,
	bucketSignerReviewProofsV2,
	bucketSignerReviewsV2,
	bucketSignerJupiterTriggerV2,
	bucketSignerRotationsV2,
	bucketSignerOperatorNoncesV2,
}

var signerStateSchemaContractV2 = migration.NewContract(
	signerStateBucketsV2,
	bucketSignerMetaV2,
	[]byte("schemaVersion"),
	bucketSignerWebAuthnCredentialsV2,
	signerWebAuthnCredentialsVersionKeyV2,
	[]byte("capabilities"),
)

type signerSchemaHealthV2 = migration.SchemaHealth

func inspectSignerStateBeforeOpenV2(path string) (bool, bool, error) {
	return migration.InspectStateBeforeOpen(path)
}

func inspectSignerSchemaReadOnlyV2(path string) (uint64, error) {
	return migration.InspectSchemaReadOnly(path, signerStateSchemaContractV2)
}

func readSignerSchemaVersionV2(db *signerstore.DB) (uint64, error) {
	return migration.ReadVersion(db, signerStateSchemaContractV2)
}

func readSignerSchemaVersionFromTxV2(tx *bolt.Tx) (uint64, error) {
	return migration.ReadVersionFromTx(tx, signerStateSchemaContractV2)
}

func migrateSignerStateV2(db *signerstore.DB, fromVersion uint64) error {
	capabilities, err := json.Marshal(signerV2Capabilities)
	if err != nil {
		return fmt.Errorf("encode signer capabilities for migration: %w", err)
	}
	return migration.Migrate(db, fromVersion, signerStateSchemaContractV2.WithCapabilities(capabilities))
}

func validateSignerSchemaBucketsV2(db *signerstore.DB) error {
	return migration.ValidateBuckets(db, signerStateSchemaContractV2)
}

func backupSignerStateBeforeMigrationV2(db *signerstore.DB, statePath string) (string, error) {
	return migration.BackupBeforeMigration(db, statePath)
}

func syncSignerStateDirectoryV2(path string) error {
	return migration.SyncDirectory(path)
}

func (s *signerStoreV2) schemaHealth() signerSchemaHealthV2 {
	version := uint64(0)
	if s != nil {
		version = s.schemaVersion
	}
	return migration.Health(version)
}
