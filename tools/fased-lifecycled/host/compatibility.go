package host

import (
	"errors"
	"fmt"

	"fased-lifecycled/trust"
)

type Requirements struct {
	Manifest    uint32
	Journal     uint32
	Participant uint32
	Platform    uint32
}

func VerifyCompatibility(protocols trust.HostProtocols, requirements Requirements) error {
	if err := protocols.Validate(); err != nil {
		return err
	}
	for name, check := range map[string]struct {
		supported trust.ProtocolRange
		required  uint32
	}{
		"manifest": {protocols.Manifest, requirements.Manifest}, "journal": {protocols.Journal, requirements.Journal},
		"participant": {protocols.Participant, requirements.Participant}, "platform": {protocols.Platform, requirements.Platform},
	} {
		if check.required == 0 {
			return errors.New("lifecycle-host protocol requirements must be nonzero")
		}
		if check.required < check.supported.Min || check.required > check.supported.Max {
			return fmt.Errorf("lifecycle-host does not support required %s protocol %d", name, check.required)
		}
	}
	return nil
}
