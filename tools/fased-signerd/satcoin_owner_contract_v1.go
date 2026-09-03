package main

import (
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

var satcoinOwnerInstructionContractsV1 = map[string]ownerCeremonyContractV1{
	"sat_init_agent_record": {
		ProgramID: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret -- public Satcoin program ID
		DataSize:  193,
		Disc:      [8]byte{96},
		DiscSize:  1,
		Accounts: []agentIdentityAccountContractV1{
			{Name: "permanent_mining_id", IsSigner: true},
			{Name: "controller", IsSigner: true, IsWritable: true},
			{Name: "active_miner_authority", IsSigner: true},
			{Name: "sat_agent_record", IsWritable: true},
			{Name: "system_program", Address: "11111111111111111111111111111111"},
		},
	},
	"sat_init_miner_capital": {
		ProgramID: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret -- public Satcoin program ID
		DataSize:  33,
		Disc:      [8]byte{36},
		DiscSize:  1,
		Accounts: []agentIdentityAccountContractV1{
			{Name: "signer", IsSigner: true, IsWritable: true},
			{Name: "permanent_mining_id"},
			{Name: "sat_agent_record"},
			{Name: "sat_miner_capital_state", IsWritable: true},
			{Name: "system_program", Address: "11111111111111111111111111111111"},
		},
	},
}

func satcoinOwnerPubkeyV1(data []byte, offset int) (solana.PublicKey, error) {
	if offset < 0 || offset+solana.PublicKeyLength > len(data) {
		return solana.PublicKey{}, errors.New("Satcoin owner ceremony public-key field is truncated")
	}
	return solana.PublicKeyFromBytes(data[offset : offset+solana.PublicKeyLength]), nil
}

func validateSatcoinOwnerCeremonyV1(action string, program solana.PublicKey, data []byte, accounts solana.AccountMetaSlice) error {
	if action != "sat_init_agent_record" && action != "sat_init_miner_capital" {
		return nil
	}
	if len(accounts) != 5 {
		return errors.New("Satcoin owner ceremony account layout changed")
	}
	permanent, err := satcoinOwnerPubkeyV1(data, 1)
	if err != nil {
		return err
	}
	record, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_agent_record"), permanent[:]}, program)
	if err != nil {
		return err
	}
	if action == "sat_init_miner_capital" {
		authority := permanent
		if !accounts[0].PublicKey.Equals(authority) || !accounts[1].PublicKey.Equals(authority) || !accounts[2].PublicKey.Equals(record) {
			return errors.New("Satcoin miner-capital authority or derived AgentRecord changed")
		}
		capital, _, deriveErr := solana.FindProgramAddress([][]byte{[]byte("sat_miner_capital_state"), authority[:]}, program)
		if deriveErr != nil {
			return deriveErr
		}
		if !accounts[3].PublicKey.Equals(capital) {
			return errors.New("Satcoin miner-capital PDA changed")
		}
		return nil
	}

	controller, err := satcoinOwnerPubkeyV1(data, 33)
	if err != nil {
		return err
	}
	recovery, err := satcoinOwnerPubkeyV1(data, 65)
	if err != nil {
		return err
	}
	activeMiner, err := satcoinOwnerPubkeyV1(data, 97)
	if err != nil {
		return err
	}
	runtimeExecutor, err := satcoinOwnerPubkeyV1(data, 129)
	if err != nil {
		return err
	}
	keeperPayer, err := satcoinOwnerPubkeyV1(data, 161)
	if err != nil {
		return err
	}
	if !accounts[0].PublicKey.Equals(permanent) || !accounts[1].PublicKey.Equals(controller) || !accounts[2].PublicKey.Equals(activeMiner) || !accounts[3].PublicKey.Equals(record) {
		return errors.New("Satcoin AgentRecord authority fields or derived PDA changed")
	}
	zero := solana.PublicKey{}
	for _, key := range []solana.PublicKey{permanent, controller, recovery, activeMiner, runtimeExecutor, keeperPayer} {
		if key.Equals(zero) {
			return errors.New("Satcoin AgentRecord authority cannot be zero")
		}
	}
	for _, isolated := range []solana.PublicKey{recovery, runtimeExecutor, keeperPayer} {
		if isolated.Equals(permanent) || isolated.Equals(controller) || isolated.Equals(activeMiner) {
			return errors.New("Satcoin Recovery, Runtime, and Keeper roles must be isolated from Mining and control")
		}
	}
	if recovery.Equals(runtimeExecutor) || recovery.Equals(keeperPayer) || runtimeExecutor.Equals(keeperPayer) {
		return errors.New("Satcoin Recovery, Runtime, and Keeper roles must be mutually distinct")
	}
	return nil
}
