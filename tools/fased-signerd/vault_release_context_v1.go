package main

import (
	"errors"
)

// Deployment pins are source-reviewed constants embedded in the managed signer
// artifact. The release index authenticates those bytes; this function is not an
// independent proof that the running executable was installed by that verifier.
// Do not add environment, Gateway, URL or caller-supplied pin overrides.
type vaultReleaseContextV1 struct {
	Cluster string
	Genesis string
	Capital vaultProgramPinV1
	Satcoin vaultProgramPinV1
}

func signerVaultReleaseContextV1(cluster, verifiedGenesis string) (vaultReleaseContextV1, error) {
	identity, err := signerReleaseIdentity()
	if err != nil {
		return vaultReleaseContextV1{}, err
	}
	if identity.Development {
		return vaultReleaseContextV1{}, errors.New("development signer has no authorized Vault deployment")
	}
	if cluster != "devnet" || verifiedGenesis == "" {
		return vaultReleaseContextV1{}, errors.New("unsupported Vault release network")
	}
	// Deliberately no enabled entry: the amended Capital binary has local build
	// evidence only. Populate an exact network/genesis-bound entry through a
	// protected source change after finalized ProgramData/ELF readback. Never
	// use the previous Capital deployment or infer a deployment slot from RPC.
	return vaultReleaseContextV1{}, errors.New("Vault deployment is not enabled in this signer release")
}

func verifySignerVaultDeploymentV1(cluster, verifiedGenesis string, capital, satcoin signerOwnedAccountSnapshotV2, stateSlot uint64) error {
	context, err := signerVaultReleaseContextV1(cluster, verifiedGenesis)
	if err != nil {
		return err
	}
	if context.Cluster != cluster || context.Genesis != verifiedGenesis {
		return errors.New("Vault release genesis mismatch")
	}
	return verifyVaultDeploymentPairV1(context.Capital, context.Satcoin, capital, satcoin, stateSlot)
}
