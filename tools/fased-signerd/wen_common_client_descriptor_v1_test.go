package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestWENCommonClientDescriptorV1(t *testing.T) {
	raw, err := os.ReadFile("testdata/wen-common-client-descriptor.json")
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Interfaces struct {
			Staking struct {
				Capability string `json:"capabilityDigest"`
			} `json:"stakingChangeHandoff"`
			Withdrawal struct {
				Capability string `json:"capabilityDigest"`
			} `json:"withdrawalHandoff"`
		}
	}
	if err = json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	_, pins := stakingDescriptorFixture(t)
	pins.DescriptorSHA256 = wenHashV1(raw)
	pins.CapabilitySHA256 = d.Interfaces.Staking.Capability
	if err = validateWENStakingDescriptorV1(raw, pins); err != nil {
		t.Fatal("common staking descriptor", err)
	}
	if err = validateWENWithdrawalDescriptorV1(raw, pins); err == nil {
		t.Fatal("staking capability accepted as withdrawal")
	}
	pins.CapabilitySHA256 = d.Interfaces.Withdrawal.Capability
	if err = validateWENWithdrawalDescriptorV1(raw, pins); err != nil {
		t.Fatal("common withdrawal descriptor", err)
	}
	if err = validateWENStakingDescriptorV1(raw, pins); err == nil {
		t.Fatal("withdrawal capability accepted as staking")
	}
}
